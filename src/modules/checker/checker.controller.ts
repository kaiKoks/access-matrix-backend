import { Body, Controller, Get, Post } from '@nestjs/common';
import { CheckerService } from './checker.service.js';
import { CheckRuleRequestDto, CheckRuleResponseDto } from '../../common/dto/check-rule.dto.js';

@Controller('api/checker')
export class CheckerController {
  constructor(private readonly checkerService: CheckerService) {}

  // Для проверки в браузере по адресу http://localhost:3000/api/checker/test-rule
  @Get('test-rule')
  healthCheck() {
    return {
      ok: true,
      message: 'Эндпоинт /api/checker/test-rule работает',
    };
  }

  @Post('test-rule')
  async testRule(@Body() dto: CheckRuleRequestDto): Promise<CheckRuleResponseDto> {
    console.log(
      `[Checker] Проверка правила: источников=${dto.sources?.length || 0}, назначений=${dto.destinations?.length || 0}`,
    );
    return this.checkerService.checkRule(dto);
  }
}