import { Injectable, BadGatewayException } from '@nestjs/common';

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
}

@Injectable()
export class ZabbixApiService {
  private cachedScannerHost: ScannerHostInfo | null = null;

  private get apiUrl(): string {
    return (process.env.ZABBIX_API_URL || '').trim();
  }

  private get apiToken(): string {
    return (process.env.ZABBIX_API_TOKEN || '').trim();
  }

  // Строгий вызов JSON-RPC 2.0 по спецификации Zabbix 7.0 (Authorization: Bearer)
  async rpcCall<T>(method: string, params: Record<string, any> | any[], id = 1): Promise<T> {
    if (!this.apiUrl) {
      throw new BadGatewayException('Не задан ZABBIX_API_URL в файле backend/.env');
    }
    if (!this.apiToken) {
      throw new BadGatewayException('Не задан ZABBIX_API_TOKEN в файле backend/.env');
    }

    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json-rpc',
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: any) {
      throw new BadGatewayException(
        `Сетевая ошибка при обращении к Zabbix API (${this.apiUrl}): ${err.message}`,
      );
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `Zabbix веб-сервер вернул HTTP ${response.status} (${response.statusText}) по адресу ${this.apiUrl}`,
      );
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new BadGatewayException(
        `Zabbix вернул HTML вместо JSON. Убедитесь, что ZABBIX_API_URL заканчивается на /api_jsonrpc.php`,
      );
    }

    if (data.error) {
      throw new BadGatewayException(
        `Ошибка Zabbix API [${data.error.code}]: ${data.error.message} — ${data.error.data || ''}`,
      );
    }

    return data.result as T;
  }

  // Находит в Zabbix узел-сканер (рабочую станцию или Zabbix server), на котором будут выполняться проверки
  async resolveScannerHost(): Promise<ScannerHostInfo> {
    if (this.cachedScannerHost) {
      return this.cachedScannerHost;
    }

    const preferredHost = process.env.ZABBIX_SCANNER_HOST?.trim();

    if (preferredHost) {
      // 1. Поиск по IP интерфейса агента
      const byIp = await this.rpcCall<Array<{ hostid: string; interfaceid: string }>>(
        'hostinterface.get',
        {
          output: ['hostid', 'interfaceid'],
          filter: { ip: preferredHost, type: 1 },
        },
      );

      if (byIp?.length > 0) {
        this.cachedScannerHost = {
          hostid: byIp[0].hostid,
          interfaceid: byIp[0].interfaceid,
          host: preferredHost,
        };
        return this.cachedScannerHost;
      }

      // 2. Поиск по имени хоста в Zabbix
      const byName = await this.rpcCall<Array<{ hostid: string; host: string }>>('host.get', {
        output: ['hostid', 'host'],
        search: { host: preferredHost },
      });

      if (byName?.length > 0) {
        const ifaceId = await this.getAgentInterfaceId(byName[0].hostid);
        this.cachedScannerHost = {
          hostid: byName[0].hostid,
          interfaceid: ifaceId,
          host: byName[0].host,
        };
        return this.cachedScannerHost;
      }

      throw new BadGatewayException(
        `Узел-сканер ZABBIX_SCANNER_HOST="${preferredHost}" не найден в Zabbix`,
      );
    }

    // Если ZABBIX_SCANNER_HOST не указан — берем первый активный узел с Zabbix Agent
    const interfaces = await this.rpcCall<
      Array<{ hostid: string; interfaceid: string; ip: string }>
    >('hostinterface.get', {
      output: ['hostid', 'interfaceid', 'ip'],
      filter: { type: 1, main: 1 },
      limit: 1,
    });

    if (!interfaces || interfaces.length === 0) {
      throw new BadGatewayException(
        'В Zabbix не найдено ни одного узла с интерфейсом Zabbix Agent. Добавьте хост рабочей станции в Zabbix.',
      );
    }

    this.cachedScannerHost = {
      hostid: interfaces[0].hostid,
      interfaceid: interfaces[0].interfaceid,
      host: interfaces[0].ip,
    };

    return this.cachedScannerHost;
  }

  private async getAgentInterfaceId(hostId: string): Promise<string> {
    const interfaces = await this.rpcCall<Array<{ interfaceid: string }>>('hostinterface.get', {
      output: ['interfaceid'],
      hostids: hostId,
      filter: { type: 1 },
    });

    if (!interfaces || interfaces.length === 0) {
      throw new BadGatewayException(
        `У выбранного хоста (hostid=${hostId}) в Zabbix нет интерфейса Zabbix Agent`,
      );
    }

    return interfaces[0].interfaceid;
  }

  // Получает элементы данных, автоматически создает недостающие и ждет реального результата (lastclock > 0)
  async ensureAndPollItems(
    hostInfo: ScannerHostInfo,
    keys: string[],
  ): Promise<Map<string, ZabbixItemResult>> {
    const uniqueKeys = Array.from(new Set(keys));
    if (uniqueKeys.length === 0) {
      return new Map();
    }

    // 1. Ищем уже существующие элементы на узле-сканере
    const existingItems = await this.rpcCall<ZabbixItemResult[]>('item.get', {
      output: ['itemid', 'key_', 'lastvalue', 'lastclock', 'state', 'error'],
      hostids: hostInfo.hostid,
      filter: { key_: uniqueKeys },
    });

    const resultMap = new Map<string, ZabbixItemResult>();
    existingItems.forEach((item) => {
      resultMap.set(item.key_.replace(/\s+/g, ''), item);
    });

    // 2. Определяем, каких ключей еще нет в Zabbix, и создаем их через item.create
    const missingKeys = uniqueKeys.filter((k) => !resultMap.has(k.replace(/\s+/g, '')));
    const newlyCreatedIds: string[] = [];

    for (const key of missingKeys) {
      const created = await this.rpcCall<{ itemids: string[] }>('item.create', {
        name: `Matrix Check: ${key}`,
        key_: key,
        hostid: hostInfo.hostid,
        type: 0, // 0 = Zabbix agent
        value_type: 3, // 3 = Numeric (unsigned)
        interfaceid: hostInfo.interfaceid,
        delay: '30s',
      });

      if (created?.itemids?.[0]) {
        newlyCreatedIds.push(created.itemids[0]);
      }
    }

    // 3. Собираем ID элементов, которые еще ни разу не опрашивались (lastclock === '0') или только что созданы
    const allTargetItemIds = [
      ...existingItems.map((i) => i.itemid),
      ...newlyCreatedIds,
    ];

    // Отправляем task.create (type: 6 — Execute now) для обновления значений
    const triggerExecuteNow = async (itemIds: string[]) => {
      if (itemIds.length === 0) return;
      try {
        await this.rpcCall(
          'task.create',
          itemIds.map((itemid) => ({
            type: 6,
            request: { itemid },
          })),
        );
      } catch {
        // Игнорируем, если task.create временно отклонен до синхронизации кэша
      }
    };

    await triggerExecuteNow(allTargetItemIds);

    // 4. Если все элементы УЖЕ существовали и имели lastclock > 0, достаточно подождать 1.5 сек для свежего опроса.
    // Если есть новые элементы с lastclock === '0', ждем до 15 секунд (пока Zabbix обновит Configuration Cache).
    const hasNeverPolledItems =
      newlyCreatedIds.length > 0 || existingItems.some((i) => !i.lastclock || i.lastclock === '0');

    const maxAttempts = hasNeverPolledItems ? 6 : 1;
    const delayMs = hasNeverPolledItems ? 2500 : 1200;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, delayMs));

      const polledItems = await this.rpcCall<ZabbixItemResult[]>('item.get', {
        output: ['itemid', 'key_', 'lastvalue', 'lastclock', 'state', 'error'],
        hostids: hostInfo.hostid,
        filter: { key_: uniqueKeys },
      });

      resultMap.clear();
      polledItems.forEach((item) => {
        resultMap.set(item.key_.replace(/\s+/g, ''), item);
      });

      // Проверяем, у всех ли элементов появился реальный lastclock > 0
      const stillPending = polledItems.filter((i) => !i.lastclock || i.lastclock === '0');
      if (stillPending.length === 0) {
        break;
      }

      // Повторно шлем task.create для тех, кто только что попал в Configuration Cache
      await triggerExecuteNow(stillPending.map((i) => i.itemid));
    }

    return resultMap;
  }
}