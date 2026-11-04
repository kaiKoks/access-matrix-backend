import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CheckerModule } from './modules/checker/checker.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { MatrixSystemEntity } from './modules/catalog/entities/matrix-system.entity.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
        type: 'better-sqlite3',
        database: config.get<string>('DATABASE_PATH', 'database.sqlite'),
        entities: [MatrixSystemEntity],
        synchronize: true,
      }),
    }),
    CheckerModule,
    CatalogModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
