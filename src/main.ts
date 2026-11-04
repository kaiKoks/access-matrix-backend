import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Разрешаем запросы с фронтенда
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  });

  // Увеличиваем встроенный лимит тела запроса NestJS до 50 МБ
  app.useBodyParser('json', { limit: '50mb' });
  app.useBodyParser('urlencoded', { limit: '50mb', extended: true });

  // Логируем каждый приходящий с фронта запрос в консоль
  app.use((req: any, _res: any, next: () => void) => {
    console.log(`[Backend API] ${req.method} ${req.originalUrl}`);
    next();
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`=== Бэкенд успешно запущен на http://localhost:${port} ===`);
}
void bootstrap();
