import { Module } from '@nestjs/common';
import { CheckerController } from './checker.controller.js';
import { CheckerService } from './checker.service.js';
import { ZabbixApiService } from './zabbix-api.service.js';

@Module({
  controllers: [CheckerController], 
  providers: [CheckerService, ZabbixApiService],
})
export class CheckerModule {}