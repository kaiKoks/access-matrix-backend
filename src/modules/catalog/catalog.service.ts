import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MatrixSystemEntity } from './entities/matrix-system.entity.js';
import * as fs from 'fs';
import * as path from 'path';

export interface SavedMatrixSystem {
  id: string;
  name: string;
  updatedAt: string;
  sheets: any[];
}

@Injectable()
export class CatalogService implements OnModuleInit {
  constructor(
    @InjectRepository(MatrixSystemEntity)
    private readonly matrixRepo: Repository<MatrixSystemEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
  }


  async getAllSystems(): Promise<SavedMatrixSystem[]> {
    const list = await this.matrixRepo.find();
    return list.filter(
      (sys) =>
        Array.isArray(sys.sheets) &&
        sys.sheets.some((sh) => Array.isArray(sh.rows) && sh.rows.length > 0),
    );
  }

  async saveSystem(name: string, sheets: any[]): Promise<SavedMatrixSystem> {
    const cleanName = (name || 'Матрица').trim();
    const list = await this.matrixRepo.find();
    const existing = list.find(
      (s) => s.name.toLowerCase() === cleanName.toLowerCase(),
    );

    const sysId = existing ? existing.id : `sys_${Date.now()}`;

    const normalizedSheets = (sheets || [])
      .filter((sh) => Array.isArray(sh.rows) && sh.rows.length > 0)
      .map((sh) => ({
        ...sh,
        rows: sh.rows.map((r: any, idx: number) => ({
          ...r,
          __id: `${sysId}_${sh.sheetName}_${r.__rowNumber || idx + 1}`,
          __systemId: sysId,
          __systemName: cleanName,
          __sheetName: sh.sheetName,
        })),
      }));

    const totalRows = normalizedSheets.reduce((acc, s) => acc + s.rows.length, 0);
    console.log(
      `[Catalog] Сохранена матрица "${cleanName}" в БД (листов: ${normalizedSheets.length}, строк: ${totalRows})`,
    );

    const record: SavedMatrixSystem = {
      id: sysId,
      name: cleanName,
      updatedAt: new Date().toLocaleString('ru-RU'),
      sheets: normalizedSheets,
    };

    await this.matrixRepo.save(record);
    return record;
  }

  async deleteSystem(id: string): Promise<{ deleted: boolean }> {
    const result = await this.matrixRepo.delete(id);
    const deleted = (result.affected ?? 0) > 0;
    console.log(`[Catalog] Удалена матрица ID=${id} из БД (успешно: ${deleted})`);
    return { deleted };
  }
}
