import { Injectable, BadGatewayException, BadRequestException, Logger } from '@nestjs/common';
import * as dgram from 'node:dgram';
import { ZabbixApiService, ItemSpec, ResolvedSourceTarget } from './zabbix-api.service.js';
import {
  CheckRuleRequestDto,
  CheckRuleResponseDto,
  SocketCheckItem,
} from '../../common/dto/check-rule.dto.js';

interface ExpandedPort {
  port: string;
  rangeNote?: string;
}

interface RawCombination {
  id: string;
  source: string;
  destination: string;
  cleanDestHost: string;
  port: string;
  rangeNote?: string;
  protocol: 'TCP' | 'UDP';
  zabbixKey: string;
  zabbixItemType: number;
}

@Injectable()
export class CheckerService {
  private readonly logger = new Logger(CheckerService.name);

  constructor(private readonly zabbixApi: ZabbixApiService) {}

  private failGateway(message: string): never {
    this.logger.error(message);
    throw new BadGatewayException(message);
  }

  private failBadRequest(message: string): never {
    this.logger.error(message);
    throw new BadRequestException(message);
  }

  private extractCleanHost(rawEndpoint: string): string {
    let cleaned = rawEndpoint.trim();

    if (/^https?:\/\//i.test(cleaned)) {
      try {
        cleaned = new URL(cleaned).hostname;
      } catch {
        // ignore
      }
    }

    const cidrMatch = cleaned.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})\/\d{1,2}$/);
    if (cidrMatch) {
      const lastOctet = parseInt(cidrMatch[2], 10);
      return `${cidrMatch[1]}.${lastOctet === 0 ? 1 : lastOctet}`;
    }

    if (cleaned.includes('/')) {
      cleaned = cleaned.split('/')[0].trim();
    }

    if (cleaned.includes('-')) {
      const firstIp = cleaned.split('-')[0].trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(firstIp)) {
        return firstIp;
      }
    }

    return cleaned.replace(/\.$/, '');
  }

  private expandPortToken(token: string): ExpandedPort[] {
    const clean = token.replace(/^(tcp|udp)\//i, '').trim();
    const rangeMatch = clean.match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end || start < 1 || end > 65535) {
        return [];
      }

      const diff = end - start;
      if (diff <= 20) {
        return Array.from({ length: diff + 1 }, (_, i) => ({
          port: String(start + i),
        }));
      }

      const mid = Math.floor((start + end) / 2);
      const boundaryPorts = Array.from(new Set([start, mid, end]));
      return boundaryPorts.map((p) => ({
        port: String(p),
        rangeNote: `контрольная точка диапазона ${start}-${end}`,
      }));
    }

    return /^\d+$/.test(clean) ? [{ port: clean }] : [];
  }

  // Формирует единые ключи net.tcp.port и net.udp.port для ВСЕХ портов без ограничений
  private buildCombinations(dto: CheckRuleRequestDto): RawCombination[] {
    const sources = dto.sources?.length ? dto.sources : ['LocalHost'];
    const destinations = dto.destinations?.length ? dto.destinations : ['Unknown'];
    const defaultAgentType = Number(process.env.ZABBIX_ITEM_TYPE || 0);
    const combinations: RawCombination[] = [];

    for (const src of sources) {
      for (const dst of destinations) {
        const cleanDestHost = this.extractCleanHost(dst);

        for (const portGroup of dto.ports || []) {
          for (const rawPort of portGroup.list || []) {
            const expanded = this.expandPortToken(rawPort);

            for (const { port, rangeNote } of expanded) {
              const zabbixKey =
                portGroup.protocol === 'UDP'
                  ? `net.udp.port[${cleanDestHost},${port}]`
                  : `net.tcp.port[${cleanDestHost},${port}]`;

              combinations.push({
                id: `${src}->${dst}:${port}/${portGroup.protocol}`,
                source: src,
                destination: dst,
                cleanDestHost,
                port,
                rangeNote,
                protocol: portGroup.protocol,
                zabbixKey,
                zabbixItemType: defaultAgentType,
              });
            }
          }
        }
      }
    }

    return combinations;
  }

  // Резервная UDP-проверка сокетом для любого порта, если на Zabbix Agent еще не прописан UserParameter
  private probeUdpSocket(
    host: string,
    port: number,
    timeoutMs = 1500,
  ): Promise<{ value: '1' | '0'; detail: string }> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let settled = false;

      const finish = (value: '1' | '0', detail: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // ignore
        }
        resolve({ value, detail });
      };

      const timer = setTimeout(() => {
        finish('0', 'нет ответа от UDP-службы за 1.5с (фильтруется или служба молчит)');
      }, timeoutMs);

      socket.on('message', (msg) => {
        finish('1', `получен UDP-ответ (${msg.length} байт)`);
      });

      socket.on('error', (err: any) => {
        if (err?.code === 'ECONNREFUSED') {
          finish('0', 'порт закрыт (ICMP Port Unreachable)');
        } else {
          finish('0', `ошибка сокета: ${err?.code || err?.message || 'unknown'}`);
        }
      });

      // Подбираем валидный пакет под популярные протоколы, чтобы служба гарантированно ответила
      let payload: Buffer;
      if (port === 53) {
        // Стандартный DNS A-запрос для "."
        payload = Buffer.from([
          0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x01, 0x00, 0x01,
        ]);
      } else if (port === 123) {
        // Стандартный 48-байтный клиентский пакет NTP v3
        payload = Buffer.alloc(48);
        payload[0] = 0x1b;
      } else {
        payload = Buffer.from('ping');
      }

      socket.connect(port, host, () => {
        socket.send(payload, (err) => {
          if (err) {
            finish('0', `ошибка отправки: ${err.message}`);
          }
        });
      });
    });
  }

  async checkRule(dto: CheckRuleRequestDto): Promise<CheckRuleResponseDto> {
    try {
      const mode = (process.env.CHECKER_MODE || 'mock').trim().toLowerCase();
      const combinations = this.buildCombinations(dto);

      if (combinations.length === 0) {
        this.failBadRequest('В правиле не найдено корректных IP и портов для проверки');
      }

      if (mode === 'zabbix') {
        return await this.checkViaZabbixApi(combinations);
      }

      return await this.checkViaMock(combinations);
    } catch (err: any) {
      if (!(err instanceof BadGatewayException || err instanceof BadRequestException)) {
        this.logger.error(`Непредвиденная ошибка при проверке правила: ${err?.message || err}`);
      }
      throw err;
    }
  }

  private async checkViaZabbixApi(combinations: RawCombination[]): Promise<CheckRuleResponseDto> {
    const sourceTargets = new Map<string, ResolvedSourceTarget>();
    for (const combo of combinations) {
      if (!sourceTargets.has(combo.source)) {
        const resolved = await this.zabbixApi.resolveSourceTarget(combo.source);
        sourceTargets.set(combo.source, resolved);
      }
    }

    const specsByHostId = new Map<string, { target: ResolvedSourceTarget; specs: ItemSpec[] }>();
    for (const combo of combinations) {
      const target = sourceTargets.get(combo.source)!;
      if (!target.hostInfo) continue;

      const entry = specsByHostId.get(target.hostInfo.hostid) || { target, specs: [] };
      entry.specs.push({ key: combo.zabbixKey, type: combo.zabbixItemType });
      specsByHostId.set(target.hostInfo.hostid, entry);
    }

    const polledByHostId = new Map<string, Map<string, any>>();
    for (const [hostId, { target, specs }] of specsByHostId.entries()) {
      const itemsMap = await this.zabbixApi.ensureAndPollItems(target.hostInfo!, specs);
      polledByHostId.set(hostId, itemsMap);
    }

    const socketResults: SocketCheckItem[] = [];
    const logLines: string[] = [
      `[${new Date().toLocaleTimeString()}] Zabbix API JSON-RPC 2.0 (Проверка Source -> Destination)`,
      `Всего проверяемых связок: ${combinations.length}`,
      `------------------------------------------------------------`,
    ];

    for (const combo of combinations) {
      const destWithPort = combo.destination.endsWith(`:${combo.port}`)
        ? combo.destination
        : `${combo.destination}:${combo.port}`;
      const rangeSuffix = combo.rangeNote ? ` [${combo.rangeNote}]` : '';
      const target = sourceTargets.get(combo.source)!;

      if (!target.hostInfo) {
        socketResults.push({
          id: combo.id,
          source: combo.source,
          destination: combo.destination,
          port: combo.port,
          protocol: combo.protocol,
          zabbixKey: combo.zabbixKey,
          lastvalue: '0',
          lastclock: 0,
          status: 'untestable',
        });

        logLines.push(
          `[${combo.protocol}] ${combo.source} -> ${destWithPort}${rangeSuffix}\n` +
            `  НЕПРОВЕРЯЕМО: ${target.reason}`,
        );
        continue;
      }

      const itemsMap = polledByHostId.get(target.hostInfo.hostid)!;
      const normalizedLookupKey = combo.zabbixKey.replace(/\s+/g, '');
      const foundItem = itemsMap.get(normalizedLookupKey);

      if (!foundItem) {
        this.failGateway(
          `Элемент данных "${combo.zabbixKey}" не найден на узле "${target.hostInfo.host}"`,
        );
      }

      const isUnsupported = foundItem.state === '1';

      // Если на Zabbix Agent еще не прописан UserParameter=net.udp.port[*],
      // автоматически выполняем реальную проверку UDP-сокетом с бэкенда
      if (isUnsupported && combo.protocol === 'UDP') {
        const probe = await this.probeUdpSocket(combo.cleanDestHost, Number(combo.port));
        const nowSec = Math.floor(Date.now() / 1000);

        socketResults.push({
          id: combo.id,
          source: combo.source,
          destination: combo.destination,
          port: combo.port,
          protocol: combo.protocol,
          zabbixKey: combo.zabbixKey,
          lastvalue: probe.value,
          lastclock: nowSec,
          status: probe.value === '1' ? 'accessible' : 'blocked',
        });

        logLines.push(
          `[${combo.protocol}] ${combo.source} -> ${destWithPort}${rangeSuffix}\n` +
            `  Исполнитель: UDP-сокет бэкенда (на Zabbix Agent не задан UserParameter=net.udp.port[*])\n` +
            `  lastvalue: "${probe.value}" (${probe.detail}) | lastclock: ${new Date(
              nowSec * 1000,
            ).toLocaleTimeString()}`,
        );
        continue;
      }

      const lastclockNum = parseInt(foundItem.lastclock, 10) || 0;
      const isPending = !isUnsupported && lastclockNum === 0;
      const isOpen = !isUnsupported && !isPending && foundItem.lastvalue === '1';
      const lastvalue: '1' | '0' = isOpen ? '1' : '0';

      socketResults.push({
        id: combo.id,
        source: combo.source,
        destination: combo.destination,
        port: combo.port,
        protocol: combo.protocol,
        zabbixKey: combo.zabbixKey,
        lastvalue,
        lastclock: isUnsupported || isPending ? 0 : lastclockNum,
        status: isUnsupported || isPending ? 'untestable' : isOpen ? 'accessible' : 'blocked',
      });

      const statusNote = isUnsupported
        ? `НЕ ПОДДЕРЖИВАЕТСЯ АГЕНТОМ (${foundItem.error || 'unsupported key'})`
        : isPending
        ? `АГЕНТ НЕ ОТВЕТИЛ: узел "${target.hostInfo.host}" не прислал данные`
        : `lastvalue: "${foundItem.lastvalue || 'пусто'}" | lastclock: ${new Date(
            lastclockNum * 1000,
          ).toLocaleTimeString()}`;

      logLines.push(
        `[${combo.protocol}] ${combo.source} -> ${destWithPort}${rangeSuffix}\n` +
          `  Исполнитель: ${target.reason}\n` +
          `  key_: "${combo.zabbixKey}" | ${statusNote}`,
      );
    }

    const testableSockets = socketResults.filter((s) => s.status !== 'untestable');
    const hasAtLeastOneOpen = testableSockets.some((s) => s.status === 'accessible');

    const finalStatus: 'accessible' | 'blocked' | 'untestable' =
      testableSockets.length === 0
        ? 'untestable'
        : hasAtLeastOneOpen
        ? 'accessible'
        : 'blocked';

    return {
      status: finalStatus,
      socketResults,
      log: logLines.join('\n'),
      checkedAt: new Date().toLocaleTimeString(),
    };
  }

  private async checkViaMock(combinations: RawCombination[]): Promise<CheckRuleResponseDto> {
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 250));

    const nowUnix = Math.floor(Date.now() / 1000);
    const socketResults: SocketCheckItem[] = [];
    const logLines: string[] = [
      `[${new Date().toLocaleTimeString()}] РЕЖИМ ЭМУЛЯЦИИ (MOCK)`,
      `Проверено связок (IP × Порт): ${combinations.length}`,
      `------------------------------------------------------------`,
    ];

    for (const combo of combinations) {
      const isOpen = Math.random() > 0.2;
      const lastvalue: '1' | '0' = isOpen ? '1' : '0';
      const lastclock = nowUnix - Math.floor(2 + Math.random() * 40);

      socketResults.push({
        id: combo.id,
        source: combo.source,
        destination: combo.destination,
        port: combo.port,
        protocol: combo.protocol,
        zabbixKey: combo.zabbixKey,
        lastvalue,
        lastclock,
        status: isOpen ? 'accessible' : 'blocked',
      });

      const destWithPort = combo.destination.endsWith(`:${combo.port}`)
        ? combo.destination
        : `${combo.destination}:${combo.port}`;

      logLines.push(
        `[${combo.protocol}] ${combo.source} -> ${destWithPort} (IP: ${combo.cleanDestHost})\n` +
          `  key_: "${combo.zabbixKey}" | lastvalue: "${lastvalue}" | lastclock: ${new Date(
            lastclock * 1000,
          ).toLocaleTimeString()}`,
      );
    }

    const hasAtLeastOneOpen = socketResults.some((s) => s.status === 'accessible');

    return {
      status: hasAtLeastOneOpen ? 'accessible' : 'blocked',
      socketResults,
      log: logLines.join('\n'),
      checkedAt: new Date().toLocaleTimeString(),
    };
  }
}
