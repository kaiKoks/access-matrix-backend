import { Injectable, BadGatewayException } from '@nestjs/common';

export interface ZabbixItemResult {
  itemid: string;
  key_: string;
  lastvalue: string;
  lastclock: string;
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
    return process.env.ZABBIX_API_URL || '';
  }

  private get apiToken(): string {
    return process.env.ZABBIX_API_TOKEN || '';
  }

  // Вызов JSON-RPC 2.0 к Zabbix API (совместим с Zabbix 6.x и 7.0)
  async rpcCall<T>(
    method: string,
    params: Record<string, any>,
    id = 1,
  ): Promise<T> {
    if (!this.apiUrl) {
      throw new BadGatewayException(
        'Не задан ZABBIX_API_URL в файле backend/.env',
      );
    }
    if (!this.apiToken) {
      throw new BadGatewayException(
        'Не задан ZABBIX_API_TOKEN в файле backend/.env',
      );
    }

    const executeRequest = async (useBearerHeader: boolean) => {
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
        throw new BadGatewayException(
          `Не удалось подключиться к Zabbix API (${this.apiUrl}): ${err.message}`,
        );
      }

      if (!response.ok) {
        throw new BadGatewayException(
          `Zabbix сервер вернул HTTP ${response.status}: ${response.statusText}`,
        );
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        throw new BadGatewayException(
          `Zabbix вернул HTML вместо JSON. Проверьте ZABBIX_API_URL (должен оканчиваться на /api_jsonrpc.php)`,
        );
      }

      return data;
    };

    // Сначала пробуем стандартный Bearer-заголовок (Zabbix 6.4 / 7.0),
    // при ошибке параметра auth автоматически пробуем поле auth в теле запроса
    let data = await executeRequest(true);
    if (
      data.error &&
      /auth|authorized/i.test(`${data.error.message} ${data.error.data}`)
    ) {
      data = await executeRequest(false);
    }

    if (data.error) {
      throw new BadGatewayException(
        `Ошибка Zabbix RPC [${data.error.code}]: ${data.error.message} (${data.error.data || ''})`,
      );
    }

    return data.result as T;
  }

  // Находит узел-сканер в Zabbix (рабочую станцию или Zabbix server), с которого агент проверяет порты
  async resolveScannerHost(): Promise<ScannerHostInfo> {
    if (this.cachedScannerHost) {
      return this.cachedScannerHost;
    }

    const preferredHost = process.env.ZABBIX_SCANNER_HOST?.trim();

    // 1. Если в .env явно задано имя или IP рабочей станции (ZABBIX_SCANNER_HOST)
    if (preferredHost) {
      const byIp = await this.rpcCall<
        Array<{ hostid: string; interfaceid: string }>
      >('hostinterface.get', {
        output: ['hostid', 'interfaceid'],
        filter: { ip: preferredHost, type: 1 },
      });

      if (byIp?.length > 0) {
        this.cachedScannerHost = {
          hostid: byIp[0].hostid,
          interfaceid: byIp[0].interfaceid,
          host: preferredHost,
        };
        return this.cachedScannerHost;
      }

      const byName = await this.rpcCall<
        Array<{ hostid: string; host: string }>
      >('host.get', {
        output: ['hostid', 'host'],
        search: { host: preferredHost },
      });

      if (byName?.length > 0) {
        const iface = await this.getAgentInterfaceId(byName[0].hostid);
        this.cachedScannerHost = {
          hostid: byName[0].hostid,
          interfaceid: iface,
          host: byName[0].host,
        };
        return this.cachedScannerHost;
      }

      throw new BadGatewayException(
        `Узел-сканер ZABBIX_SCANNER_HOST="${preferredHost}" не найден на сервере Zabbix`,
      );
    }

    // 2. Если ZABBIX_SCANNER_HOST не задан — берем первый доступный узел с Zabbix-агентом в системе
    const allAgentInterfaces = await this.rpcCall<
      Array<{ hostid: string; interfaceid: string; ip: string }>
    >('hostinterface.get', {
      output: ['hostid', 'interfaceid', 'ip'],
      filter: { type: 1, main: 1 },
      limit: 1,
    });

    if (!allAgentInterfaces || allAgentInterfaces.length === 0) {
      throw new BadGatewayException(
        'В Zabbix не найдено ни одного узла сети с интерфейсом Zabbix Agent. Создайте хост рабочей станции в Zabbix.',
      );
    }

    const chosen = allAgentInterfaces[0];
    this.cachedScannerHost = {
      hostid: chosen.hostid,
      interfaceid: chosen.interfaceid,
      host: chosen.ip,
    };

    return this.cachedScannerHost;
  }

  private async getAgentInterfaceId(hostId: string): Promise<string> {
    const interfaces = await this.rpcCall<Array<{ interfaceid: string }>>(
      'hostinterface.get',
      {
        output: ['interfaceid'],
        hostids: hostId,
        filter: { type: 1 },
      },
    );

    if (!interfaces || interfaces.length === 0) {
      throw new BadGatewayException(
        `У хоста (hostid=${hostId}) в Zabbix отсутствует интерфейс типа Zabbix Agent`,
      );
    }

    return interfaces[0].interfaceid;
  }

  // Получает существующие элементы данных по списку ключей,
  // а если каких-то ключей еще нет в Zabbix — автоматически создает их и запрашивает свежие значения
  async ensureAndFetchItems(
    hostInfo: ScannerHostInfo,
    keys: string[],
  ): Promise<Map<string, ZabbixItemResult>> {
    const uniqueKeys = Array.from(new Set(keys));
    if (uniqueKeys.length === 0) {
      return new Map();
    }

    // 1. Запрашиваем уже существующие элементы на узле-сканере
    const existingItems = await this.rpcCall<ZabbixItemResult[]>('item.get', {
      output: ['itemid', 'key_', 'lastvalue', 'lastclock'],
      hostids: hostInfo.hostid,
      filter: { key_: uniqueKeys },
    });

    const resultMap = new Map<string, ZabbixItemResult>();
    existingItems.forEach((item) => {
      resultMap.set(item.key_.replace(/\s+/g, ''), item);
    });

    // 2. Определяем, каких ключей еще нет на узле в Zabbix
    const missingKeys = uniqueKeys.filter(
      (k) => !resultMap.has(k.replace(/\s+/g, '')),
    );
    const createdItemIds: string[] = [];

    // 3. Автоматически создаем недостающие элементы данных через item.create
    for (const key of missingKeys) {
      try {
        const created = await this.rpcCall<{ itemids: string[] }>(
          'item.create',
          {
            name: `Matrix AutoCheck: ${key}`,
            key_: key,
            hostid: hostInfo.hostid,
            type: 0, // 0 = Zabbix agent
            value_type: 3, // 3 = Numeric (unsigned)
            interfaceid: hostInfo.interfaceid,
            delay: '30s',
          },
        );

        if (created?.itemids?.[0]) {
          createdItemIds.push(created.itemids[0]);
        }
      } catch (err: any) {
        throw new BadGatewayException(
          `Не удалось автоматически создать элемент данных "${key}" в Zabbix: ${err.message}`,
        );
      }
    }

    // 4. Отправляем команду мгновенного опроса (Execute now / task.create) для новых элементов
    const itemsToPollNow = [
      ...createdItemIds,
      ...existingItems.filter((i) => i.lastclock === '0').map((i) => i.itemid),
    ];

    if (itemsToPollNow.length > 0) {
      try {
        await this.rpcCall(
          'task.create',
          itemsToPollNow.map((itemid) => ({
            type: 6, // 6 = Check now (проверить немедленно)
            request: { itemid },
          })),
        );
      } catch {
        // Если для активного агента task.create не поддерживается, пропускаем
      }

      // Ждем 1.5 секунды, чтобы агент успел опросить сокеты и записать ответ в БД Zabbix
      await new Promise((r) => setTimeout(r, 1500));

      const refreshedItems = await this.rpcCall<ZabbixItemResult[]>(
        'item.get',
        {
          output: ['itemid', 'key_', 'lastvalue', 'lastclock'],
          hostids: hostInfo.hostid,
          filter: { key_: uniqueKeys },
        },
      );

      resultMap.clear();
      refreshedItems.forEach((item) => {
        resultMap.set(item.key_.replace(/\s+/g, ''), item);
      });
    }

    return resultMap;
  }
}
