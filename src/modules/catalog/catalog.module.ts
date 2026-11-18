import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { MatrixSystemEntity } from './entities/matrix-system.entity.js';
import { MatrixFolderEntity } from './entities/matrix-folder.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([MatrixSystemEntity, MatrixFolderEntity])],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
