export interface PortGroupDto {
  raw?: string;
  list: string[];
  protocol: 'TCP' | 'UDP';
}

export class CheckRuleRequestDto {
  sources!: string[];
  destinations!: string[];
  ports!: PortGroupDto[];
}

export interface SocketCheckItem {
  id: string;
  source: string;
  destination: string;
  port: string;
  protocol: 'TCP' | 'UDP';
  zabbixKey: string;
  lastvalue: '1' | '0';
  lastclock: number;
  status: 'accessible' | 'blocked' | 'untestable';
}

export class CheckRuleResponseDto {
  status!: 'accessible' | 'blocked' | 'untestable';
  socketResults!: SocketCheckItem[];
  log!: string;
  checkedAt!: string;
}
