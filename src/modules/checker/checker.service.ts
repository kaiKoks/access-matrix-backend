import { Injectable, BadGatewayException, BadRequestException } from '@nestjs/common';
import { ZabbixApiService } from './zabbix-api.service.js';
import {
  CheckRuleRequestDto,
  CheckRuleResponseDto,
  SocketCheckItem,
} from '../../common/dto/check-rule.dto.js';

interface RawCombination {
  id: string;
  source: string;
  destination: string;
  cleanDestHost: string;
  port: string;
  protocol: 'TCP' | 'UDP';
  zabbixKey: string;
}

@Injectable()
export class CheckerService {
  constructor(private readonly zabbixApi: ZabbixApiService) {}

  // Извлекает рабочий IP или FQDN из подсетей (10.194.194.0/24 -> 10.194.194.1),
  // диапазонов (10.196.160.1-10.196.175.238 -> 10.196.160.1) и записей IP/DNS
  private extractCleanHost(rawEndpoint: string): string {
    let cleaned = rawEndpoint.trim();

    if (/^https?:\/\//i.test(cleaned)) {
      try {
        cleaned = new URL(cleaned).hostname;
      } catch {
        // ignore
      }
    }

    // 1. Обработка CIDR-подсетей вида "10.194.194.0/24" -> берем первый адрес "10.194.194.1"
    const cidrMatch = cleaned.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})\/\d{1,2}$/);
    if (cidrMatch) {
      const lastOctet = parseInt(cidrMatch[2], 10);
      return `${cidrMatch[1]}.${lastOctet === 0 ? 1 : lastOctet}`;
    }

    // 2. Обработка записей через слэш вида "10.132.34.80/msk1-trpomgr01.interrao.ru."
    if (cleaned.includes('/')) {
      cleaned = cleaned.split('/')[0].trim();
    }

    // 3. Обработка диапазонов IP вида "10.196.160.1-10.196.175.238" -> берем первый IP
    if (cleaned.includes('-')) {
      const firstIp = cleaned.split('-')[0].trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(firstIp)) {
        return firstIp;
      }
    }

    return cleaned.replace(/\.$/, '');
  }

  // Разворачивает диапазоны портов ("15000-15001" -> ["15000", "15001"])
  private expandPortToken(token: string): string[] {
    const clean = token.replace(/^(tcp|udp)\//i, '').trim();
    const rangeMatch = clean.match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      const diff = end - start;
      if (diff > 0 && diff <= 5) {
        return Array.from({ length: diff + 1 }, (_, i) => String(start + i));
      }
      return [clean];
    }
    return /^\d+$/.test(clean) ? [clean] : [];
  }

  private buildCombinations(dto: CheckRuleRequestDto): RawCombination[] {
    const sources = dto.sources?.length ? dto.sources : ['LocalHost'];
    const destinations = dto.destinations?.length ? dto.destinations : ['Unknown'];
    const combinations: RawCombination[] = [];

    for (const src of sources) {
      for (const dst of destinations) {
        const cleanDestHost = this.extractCleanHost(dst);

        for (const portGroup of dto.ports || []) {
          for (const rawPort of portGroup.list || []) {
            const expanded = this.expandPortToken(rawPort);

            for (const port of expanded) {
              // Формируем универсальный ключ с реальным целевым IP без лишних пробелов
              const zabbixKey =
                portGroup.protocol === 'UDP'
                  ? `custom.udp.check[${cleanDestHost},${port}]`
                  : `net.tcp.port[${cleanDestHost},${port}]`;

              combinations.push({
                id: `${src}->${dst}:${port}/${portGroup.protocol}`,
                source: src,
                destination: dst,
                cleanDestHost,
                port,
                protocol: portGroup.protocol,
                zabbixKey,
              });
            }
          }
        }
      }
    }

    return combinations;
  }

  async checkRule(dto: CheckRuleRequestDto): Promise<CheckRuleResponseDto> {
    const mode = dto.mode || (process.env.CHECKER_MODE as 'zabbix' | 'mock') || 'mock';
    const combinations = this.buildCombinations(dto);

    if (combinations.length === 0) {
      throw new BadRequestException('В правиле не найдено корректных IP и портов для проверки');
    }

    // Никакого перехода на mock при ошибке: в режиме zabbix любая проблема выбрасывает исключение
    if (mode === 'zabbix') {
      return await this.checkViaZabbixApi(combinations);
    }

    return await this.checkViaMock(combinations);
  }

  // 1. Боевой опрос через Zabbix API с автосозданием недостающих элементов на узле-сканере
  private async checkViaZabbixApi(combinations: RawCombination[]): Promise<CheckRuleResponseDto> {
    const scannerHost = await this.zabbixApi.resolveScannerHost();
    const allKeys = combinations.map((c) => c.zabbixKey);

    const itemsMap = await this.zabbixApi.ensureAndFetchItems(scannerHost, allKeys);

    const socketResults: SocketCheckItem[] = [];
    const nowUnix = Math.floor(Date.now() / 1000);
    const logLines: string[] = [
      `[${new Date().toLocaleTimeString()}] Zabbix API JSON-RPC 2.0 (Узел-сканер: ${scannerHost.host}, hostid=${scannerHost.hostid})`,
      `Проверено связок (IP × Порт): ${combinations.length}`,
      `------------------------------------------------------------`,
    ];

    for (const combo of combinations) {
      const normalizedLookupKey = combo.zabbixKey.replace(/\s+/g, '');
      const foundItem = itemsMap.get(normalizedLookupKey);

      if (!foundItem) {
        throw new BadGatewayException(
          `Элемент данных "${combo.zabbixKey}" не удалось получить с узла-сканера (hostid=${scannerHost.hostid})`,
        );
      }

      const isOpen = foundItem.lastvalue === '1';
      const lastvalue: '1' | '0' = isOpen ? '1' : '0';
      const lastclock = parseInt(foundItem.lastclock, 10) || nowUnix;

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
        `[${combo.protocol}] ${combo.source} -> ${destWithPort} (проверен IP: ${combo.cleanDestHost})\n` +
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

  // 2. Режим эмуляции Zabbix API (работает ТОЛЬКО когда явно выбран режим mock)
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