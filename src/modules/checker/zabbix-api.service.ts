import { Injectable, BadGatewayException, Logger } from '@nestjs/common';

export interface ZabbixItemResult {
  itemid: string;
  key_: string;
  lastvalue: string;
  lastclock: string;
  state?: string;
  error?: string;
}

export interface ScannerHostInfo {
  hostid: string;
  interfaceid: string;
  host: string;
  available: string;
  interfaceError: string;
}

export interface ResolvedSourceTarget {
  hostInfo: ScannerHostInfo | null;
  reason: string;
}

export interface ItemSpec {
  key: string;
  type: number; // 0 = Zabbix agent (passive), 7 = Zabbix agent (active)
}

interface ZabbixWritableHost {
  hostid: string;
  host: string;
  name: string;
  status: string;
  interfaces: Array<{
    interfaceid: string;
    type: string | number;
    main: string | number;
    ip: string;
    dns?: string;
    available?: string;
    error?: string;
  }>;
}

const VMWARE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ipToUint32(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    num = (num << 8) | octet;
  }
  return num >>> 0;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [netIp, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipNum = ipToUint32(ip);
  const netNum = ipToUint32(netIp);
  if (ipNum === null || netNum === null) return false;
  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

function isIpInRange(ip: string, startIp: string, endIp: string): boolean {
  const ipNum = ipToUint32(ip);
  const startNum = ipToUint32(startIp);
  const endNum = ipToUint32(endIp);
  if (ipNum === null || startNum === null || endNum === null) return false;
  const min = Math.min(startNum, endNum);
  const max = Math.max(startNum, endNum);
  return ipNum >= min && ipNum <= max;
}

@Injectable()
export class ZabbixApiService {
  private readonly logger = new Logger(ZabbixApiService.name);
  private cachedWritableHosts: { list: ZabbixWritableHost[]; fetchedAt: number } | null = null;

  private get apiUrl(): string {
    return (process.env.ZABBIX_API_URL || '').trim();
  }

  private get apiToken(): string {
    return (process.env.ZABBIX_API_TOKEN || '').trim();
  }

  private fail(message: string): never {
    this.logger.error(message);
    throw new BadGatewayException(message);
  }

  async rpcCall<T>(method: string, params: Record<string, any> | any[], id = 1): Promise<T> {
    if (!this.apiUrl) {
      this.fail('Не задан ZABBIX_API_URL в файле backend/.env');
    }
    if (!this.apiToken) {
      this.fail('Не задан ZABBIX_API_TOKEN в файле backend/.env');
    }

    const sendRequest = async (useBearerHeader: boolean) => {
      const payload: Record<string, any> = {
        jsonrpc: '2.0',
        method,
        params,
        id,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json-rpc',
      };

      if (useBearerHeader) {
        headers['Authorization'] = `Bearer ${this.apiToken}`;
      } else {
        payload.auth = this.apiToken;
      }

      let response: Response;
      try {
        response = await fetch(this.apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
      } catch (err: any) {
        const cause = err.cause ? ` [${err.cause.code || err.cause.message || ''}]` : '';
        this.fail(
          `Сетевая ошибка при обращении к Zabbix API (${this.apiUrl}): ${err.message}${cause}`,
        );
      }

      if (!response.ok) {
        this.fail(
          `Zabbix веб-сервер вернул HTTP ${response.status} (${response.statusText}) по адресу ${this.apiUrl}`,
        );
      }

      try {
        return await response.json();
      } catch {
        this.fail(
          'Zabbix вернул HTML вместо JSON. Убедитесь, что ZABBIX_API_URL заканчивается на /api_jsonrpc.php',
        );
      }
    };

    let data = await sendRequest(false);

    if (
      data.error &&
      /unexpected parameter\s*["']?auth["']?/i.test(`${data.error.message} ${data.error.data || ''}`)
    ) {
      data = await sendRequest(true);
    }

    if (data.error) {
      this.fail(
        `Ошибка Zabbix API [${method}] [${data.error.code}]: ${data.error.message} — ${data.error.data || ''}`,
      );
    }

    return data.result as T;
  }

  private async getWritableAgentHosts(): Promise<ZabbixWritableHost[]> {
    const now = Date.now();
    if (this.cachedWritableHosts && now - this.cachedWritableHosts.fetchedAt < 60_000) {
      return this.cachedWritableHosts.list;
    }

    const writableHosts = await this.rpcCall<ZabbixWritableHost[]>('host.get', {
      output: ['hostid', 'host', 'name', 'status'],
      filter: { status: 0 },
      editable: true,
      with_interfaces: true,
      selectInterfaces: ['interfaceid', 'type', 'main', 'ip', 'dns', 'available', 'error'],
    });

    const agentHosts = (writableHosts || []).filter((h) =>
      h.interfaces?.some((i) => Number(i.type) === 1),
    );

    this.cachedWritableHosts = { list: agentHosts, fetchedAt: now };
    return agentHosts;
  }

  private buildScannerInfo(host: ZabbixWritableHost): ScannerHostInfo {
    const agentInterface =
      host.interfaces.find(
        (i) => Number(i.type) === 1 && Number(i.main) === 1 && String(i.available) === '1',
      ) ||
      host.interfaces.find((i) => Number(i.type) === 1 && String(i.available) === '1') ||
      host.interfaces.find((i) => Number(i.type) === 1 && Number(i.main) === 1) ||
      host.interfaces.find((i) => Number(i.type) === 1)!;

    return {
      hostid: host.hostid,
      interfaceid: agentInterface.interfaceid,
      host: host.host,
      available: String(agentInterface.available ?? '0'),
      interfaceError: agentInterface.error || '',
    };
  }

  private hasActiveGreenAgent(host: ZabbixWritableHost): boolean {
    if (VMWARE_UUID_REGEX.test(host.host.trim())) {
      return false;
    }
    return host.interfaces.some((i) => Number(i.type) === 1 && String(i.available) === '1');
  }

  async resolveSourceTarget(rawSource: string): Promise<ResolvedSourceTarget> {
    const cleaned = rawSource.trim();
    const agentHosts = await this.getWritableAgentHosts();

    // 1. Source — подсеть CIDR (берем представителя с активным зеленым ZBX, исключая VMware UUID)
    const cidrMatch = cleaned.match(/(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})/);
    if (cidrMatch) {
      const cidr = cidrMatch[1];
      const activeSubnetHost = agentHosts.find(
        (h) =>
          this.hasActiveGreenAgent(h) &&
          h.interfaces.some((i) => Number(i.type) === 1 && i.ip && isIpInCidr(i.ip, cidr)),
      );

      if (!activeSubnetHost) {
        return {
          hostInfo: null,
          reason: `В подсети Source "${cidr}" нет узлов с активным Zabbix Agent (зеленый ZBX)`,
        };
      }

      const info = this.buildScannerInfo(activeSubnetHost);
      const matchedIp =
        activeSubnetHost.interfaces.find((i) => i.ip && isIpInCidr(i.ip, cidr))?.ip || '';

      return {
        hostInfo: info,
        reason: `через представителя подсети "${info.host}" (${matchedIp} ∈ ${cidr})`,
      };
    }

    // 2. Source — диапазон IP (берем представителя с активным зеленым ZBX, исключая VMware UUID)
    const rangeMatch = cleaned.match(
      /(\d{1,3}(?:\.\d{1,3}){3})\s*[–-]\s*(\d{1,3}(?:\.\d{1,3}){3})/,
    );
    if (rangeMatch) {
      const [, startIp, endIp] = rangeMatch;
      const activeRangeHost = agentHosts.find(
        (h) =>
          this.hasActiveGreenAgent(h) &&
          h.interfaces.some(
            (i) => Number(i.type) === 1 && i.ip && isIpInRange(i.ip, startIp, endIp),
          ),
      );

      if (!activeRangeHost) {
        return {
          hostInfo: null,
          reason: `В диапазоне Source "${startIp}-${endIp}" нет узлов с активным Zabbix Agent (зеленый ZBX)`,
        };
      }

      const info = this.buildScannerInfo(activeRangeHost);
      const matchedIp =
        activeRangeHost.interfaces.find((i) => i.ip && isIpInRange(i.ip, startIp, endIp))?.ip || '';

      return {
        hostInfo: info,
        reason: `через представителя диапазона "${info.host}" (${matchedIp} ∈ ${startIp}-${endIp})`,
      };
    }

    // 3. Точный поиск конкретного узла Source по IP, FQDN или видимому имени
    const parts = cleaned
      .split('/')
      .map((p) => p.trim().replace(/\.$/, '').toLowerCase())
      .filter(Boolean);

    const shortNames = parts
      .filter((p) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(p) && p.includes('.'))
      .map((fqdn) => fqdn.split('.')[0]);

    const searchTokens = new Set([...parts, ...shortNames]);

    const sortedHosts = [...agentHosts].sort((a, b) => {
      const aIsVm = VMWARE_UUID_REGEX.test(a.host.trim()) ? 1 : 0;
      const bIsVm = VMWARE_UUID_REGEX.test(b.host.trim()) ? 1 : 0;
      return aIsVm - bIsVm;
    });

    const matchedSourceHost = sortedHosts.find((h) => {
      const hostTechnical = h.host.toLowerCase();
      const hostVisible = h.name.toLowerCase();
      const hostShort = hostTechnical.split('.')[0];

      if (
        searchTokens.has(hostTechnical) ||
        searchTokens.has(hostVisible) ||
        searchTokens.has(hostShort)
      ) {
        return true;
      }

      return h.interfaces.some(
        (iface) =>
          (iface.ip && searchTokens.has(iface.ip.toLowerCase())) ||
          (iface.dns && searchTokens.has(iface.dns.toLowerCase())),
      );
    });

    if (!matchedSourceHost) {
      return {
        hostInfo: null,
        reason: `Узел-источник "${cleaned}" не найден в Zabbix, отключён или нет прав Read-Write`,
      };
    }

    const info = this.buildScannerInfo(matchedSourceHost);

    if (info.available === '2') {
      return {
        hostInfo: null,
        reason: `Zabbix Agent на источнике "${matchedSourceHost.host}" недоступен (${info.interfaceError || 'красный ZBX'})`,
      };
    }

    return {
      hostInfo: info,
      reason: `напрямую с Source "${matchedSourceHost.host}"`,
    };
  }

  private async fetchHostItemsMap(
    hostId: string,
    targetNormalizedKeys: Set<string>,
  ): Promise<Map<string, ZabbixItemResult>> {
    const allHostItems = await this.rpcCall<ZabbixItemResult[]>('item.get', {
      output: ['itemid', 'key_', 'lastvalue', 'lastclock', 'state', 'error'],
      hostids: hostId,
    });

    const map = new Map<string, ZabbixItemResult>();
    for (const item of allHostItems) {
      const norm = item.key_.replace(/\s+/g, '');
      if (targetNormalizedKeys.has(norm)) {
        map.set(norm, item);
      }
    }
    return map;
  }

  async ensureAndPollItems(
    hostInfo: ScannerHostInfo,
    specs: ItemSpec[],
  ): Promise<Map<string, ZabbixItemResult>> {
    const uniqueSpecsMap = new Map<string, ItemSpec>();
    for (const spec of specs) {
      const norm = spec.key.replace(/\s+/g, '');
      if (!uniqueSpecsMap.has(norm)) {
        uniqueSpecsMap.set(norm, spec);
      }
    }

    if (uniqueSpecsMap.size === 0) {
      return new Map();
    }

    const targetKeysSet = new Set(uniqueSpecsMap.keys());
    let resultMap = await this.fetchHostItemsMap(hostInfo.hostid, targetKeysSet);

    const missingSpecs = Array.from(uniqueSpecsMap.entries())
      .filter(([norm]) => !resultMap.has(norm))
      .map(([, spec]) => spec);

    let hasNewlyCreated = false;

    for (const spec of missingSpecs) {
      const itemPayload: Record<string, any> = {
        name: `Matrix Check: ${spec.key}`,
        key_: spec.key,
        hostid: hostInfo.hostid,
        type: spec.type,
        value_type: 3,
        delay: '30s',
      };

      if (spec.type === 0) {
        itemPayload.interfaceid = hostInfo.interfaceid;
      }

      try {
        await this.rpcCall<{ itemids: string[] }>('item.create', itemPayload);
        hasNewlyCreated = true;
      } catch (err: any) {
        if (!/already exists/i.test(err?.message || '')) {
          throw err;
        }
      }
    }

    if (missingSpecs.length > 0) {
      resultMap = await this.fetchHostItemsMap(hostInfo.hostid, targetKeysSet);
    }

    const allItems = Array.from(resultMap.values());
    const triggerExecuteNow = async (items: ZabbixItemResult[]) => {
      const validIds = items.filter((i) => i.state !== '1').map((i) => i.itemid);
      if (validIds.length === 0) return;
      try {
        await this.rpcCall(
          'task.create',
          validIds.map((itemid) => ({
            type: 6,
            request: { itemid },
          })),
        );
      } catch {
        // Игнорируем до синхронизации кэша
      }
    };

    await triggerExecuteNow(allItems);

    const hasNeverPolled =
      hasNewlyCreated ||
      allItems.some((i) => i.state !== '1' && (!i.lastclock || i.lastclock === '0'));

    const maxAttempts = hasNeverPolled ? 6 : 1;
    const delayMs = hasNeverPolled ? 2500 : 1200;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, delayMs));
      resultMap = await this.fetchHostItemsMap(hostInfo.hostid, targetKeysSet);

      const pendingItems = Array.from(resultMap.values()).filter(
        (i) => i.state !== '1' && (!i.lastclock || i.lastclock === '0'),
      );

      if (pendingItems.length === 0) {
        break;
      }

      await triggerExecuteNow(pendingItems);
    }

    return resultMap;
  }
}
