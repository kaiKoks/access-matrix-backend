import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MatrixSystemEntity } from './entities/matrix-system.entity.js';
import { MatrixFolderEntity } from './entities/matrix-folder.entity.js';

export interface SavedMatrixSystem {
  id: string;
  name: string;
  folderId: string | null;
  updatedAt: string;
  sheets: any[];
}

export interface MatrixFolder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  createdAt: string;
  updatedAt?: string;
}

@Injectable()
export class CatalogService implements OnModuleInit {
  constructor(
    @InjectRepository(MatrixSystemEntity)
    private readonly matrixRepo: Repository<MatrixSystemEntity>,
    @InjectRepository(MatrixFolderEntity)
    private readonly folderRepo: Repository<MatrixFolderEntity>,
  ) {}

  async onModuleInit(): Promise<void> {}

  // -------------------------------------------------------------
  // Папки (Folders)
  // -------------------------------------------------------------

  async getAllFolders(): Promise<MatrixFolderEntity[]> {
    return this.folderRepo.find({
      order: { order: 'ASC', name: 'ASC' },
    });
  }

  async createFolder(name: string, parentId?: string | null): Promise<MatrixFolderEntity> {
    const cleanName = (name || 'Новая папка').trim();
    if (!cleanName) {
      throw new BadRequestException('Название папки не может быть пустым');
    }

    if (parentId) {
      const parent = await this.folderRepo.findOne({ where: { id: parentId } });
      if (!parent) {
        throw new NotFoundException(`Родительская папка с ID=${parentId} не найдена`);
      }
    }

    const folder: MatrixFolderEntity = {
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      parentId: parentId || null,
      order: 0,
      createdAt: new Date().toLocaleString('ru-RU'),
      updatedAt: new Date().toLocaleString('ru-RU'),
    };

    return this.folderRepo.save(folder);
  }

  async updateFolder(
    id: string,
    update: { name?: string; parentId?: string | null; order?: number },
  ): Promise<MatrixFolderEntity> {
    const folder = await this.folderRepo.findOne({ where: { id } });
    if (!folder) {
      throw new NotFoundException(`Папка с ID=${id} не найдена`);
    }

    if (update.name !== undefined) {
      const cleanName = update.name.trim();
      if (!cleanName) {
        throw new BadRequestException('Название папки не может быть пустым');
      }
      folder.name = cleanName;
    }

    if (update.order !== undefined) {
      folder.order = update.order;
    }

    if (update.parentId !== undefined) {
      if (update.parentId === id) {
        throw new BadRequestException('Папка не может быть родителем самой себя');
      }

      if (update.parentId) {
        const allFolders = await this.folderRepo.find();
        let curr = allFolders.find((f) => f.id === update.parentId);
        while (curr && curr.parentId) {
          if (curr.parentId === id) {
            throw new BadRequestException('Нельзя переместить папку внутрь её собственной подпапки');
          }
          curr = allFolders.find((f) => f.id === curr?.parentId);
        }
        folder.parentId = update.parentId;
      } else {
        folder.parentId = null;
      }
    }

    folder.updatedAt = new Date().toLocaleString('ru-RU');
    return this.folderRepo.save(folder);
  }

  async deleteFolder(
    id: string,
    deleteContents = false,
  ): Promise<{ deleted: boolean; affectedMatrices: number }> {
    const targetFolder = await this.folderRepo.findOne({ where: { id } });
    if (!targetFolder) {
      return { deleted: false, affectedMatrices: 0 };
    }

    const allFolders = await this.folderRepo.find();

    const getDescendantIds = (rootId: string): string[] => {
      const children = allFolders.filter((f) => f.parentId === rootId);
      const res: string[] = [];
      for (const child of children) {
        res.push(child.id);
        res.push(...getDescendantIds(child.id));
      }
      return res;
    };

    const descendantFolderIds = getDescendantIds(id);
    const allAffectedFolderIds = [id, ...descendantFolderIds];

    let affectedCount = 0;

    if (deleteContents) {
      // Удаляем все матрицы внутри удаляемой папки и всех её подпапок
      const matrices = await this.matrixRepo.find({
        where: { folderId: In(allAffectedFolderIds) },
      });
      affectedCount = matrices.length;
      if (matrices.length > 0) {
        await this.matrixRepo.delete(matrices.map((m) => m.id));
      }
      // Удаляем все папки
      await this.folderRepo.delete(allAffectedFolderIds);
    } else {
      // Безопасный режим: перемещаем матрицы на уровень выше (в parentId удаляемой папки)
      const targetParentId = targetFolder.parentId ?? null;
      const matrices = await this.matrixRepo.find({
        where: { folderId: id },
      });
      affectedCount = matrices.length;
      for (const m of matrices) {
        m.folderId = targetParentId;
        await this.matrixRepo.save(m);
      }

      // Перемещаем дочерние папки на уровень выше
      const childFolders = allFolders.filter((f) => f.parentId === id);
      for (const child of childFolders) {
        child.parentId = targetParentId;
        await this.folderRepo.save(child);
      }

      // Удаляем только саму папку
      await this.folderRepo.delete(id);
    }

    console.log(
      `[Catalog] Удалена папка ID=${id} (каскадно: ${deleteContents}, затронуто матриц: ${affectedCount})`,
    );
    return { deleted: true, affectedMatrices: affectedCount };
  }

  // -------------------------------------------------------------
  // Матрицы (Matrix Systems)
  // -------------------------------------------------------------

  async getAllSystems(): Promise<SavedMatrixSystem[]> {
    const list = await this.matrixRepo.find();
    return list
      .filter(
        (sys) =>
          Array.isArray(sys.sheets) &&
          sys.sheets.some((sh) => Array.isArray(sh.rows) && sh.rows.length > 0),
      )
      .map((sys) => ({
        id: sys.id,
        name: sys.name,
        folderId: sys.folderId ?? null,
        updatedAt: sys.updatedAt,
        sheets: sys.sheets,
      }));
  }

  async saveSystem(
    name: string,
    sheets: any[],
    folderId?: string | null,
  ): Promise<SavedMatrixSystem> {
    const cleanName = (name || 'Матрица').trim();
    const list = await this.matrixRepo.find();
    const existing = list.find(
      (s) => s.name.toLowerCase() === cleanName.toLowerCase(),
    );

    const sysId = existing ? existing.id : `sys_${Date.now()}`;
    const assignedFolderId =
      folderId !== undefined ? folderId : existing ? existing.folderId ?? null : null;

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
      `[Catalog] Сохранена матрица "${cleanName}" в БД (папка: ${assignedFolderId || 'корень'}, листов: ${normalizedSheets.length}, строк: ${totalRows})`,
    );

    const record: SavedMatrixSystem = {
      id: sysId,
      name: cleanName,
      folderId: assignedFolderId,
      updatedAt: new Date().toLocaleString('ru-RU'),
      sheets: normalizedSheets,
    };

    await this.matrixRepo.save(record);
    return record;
  }

  async moveSystem(
    systemId: string,
    targetFolderId: string | null,
  ): Promise<SavedMatrixSystem> {
    const system = await this.matrixRepo.findOne({ where: { id: systemId } });
    if (!system) {
      throw new NotFoundException(`Матрица с ID=${systemId} не найдена`);
    }

    if (targetFolderId) {
      const folder = await this.folderRepo.findOne({ where: { id: targetFolderId } });
      if (!folder) {
        throw new NotFoundException(`Папка с ID=${targetFolderId} не найдена`);
      }
    }

    system.folderId = targetFolderId ?? null;
    system.updatedAt = new Date().toLocaleString('ru-RU');
    await this.matrixRepo.save(system);

    console.log(
      `[Catalog] Матрица "${system.name}" (ID=${systemId}) перемещена в папку ID=${targetFolderId ?? 'корень'}`,
    );

    return {
      id: system.id,
      name: system.name,
      folderId: system.folderId,
      updatedAt: system.updatedAt,
      sheets: system.sheets,
    };
  }

  async deleteSystem(id: string): Promise<{ deleted: boolean }> {
    const result = await this.matrixRepo.delete(id);
    const deleted = (result.affected ?? 0) > 0;
    console.log(`[Catalog] Удалена матрица ID=${id} из БД (успешно: ${deleted})`);
    return { deleted };
  }
}
