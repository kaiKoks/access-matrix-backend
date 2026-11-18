import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CatalogService } from './catalog.service.js';

@Controller('api/catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  // -----------------------------------------------------------
  // Папки (Folders)
  // -----------------------------------------------------------

  @Get('folders')
  async getAllFolders() {
    return this.catalogService.getAllFolders();
  }

  @Post('folders')
  async createFolder(@Body() body: { name: string; parentId?: string | null }) {
    return this.catalogService.createFolder(body.name, body.parentId);
  }

  @Patch('folders/:id')
  async updateFolder(
    @Param('id') id: string,
    @Body() body: { name?: string; parentId?: string | null; order?: number },
  ) {
    return this.catalogService.updateFolder(id, body);
  }

  @Delete('folders/:id')
  async deleteFolder(
    @Param('id') id: string,
    @Query('deleteContents') deleteContents?: string,
  ) {
    return this.catalogService.deleteFolder(id, deleteContents === 'true');
  }

  // -----------------------------------------------------------
  // Матрицы (Matrices)
  // -----------------------------------------------------------

  @Patch(':id/move')
  async moveSystem(
    @Param('id') id: string,
    @Body() body: { folderId: string | null },
  ) {
    return this.catalogService.moveSystem(id, body.folderId);
  }

  @Get()
  async getAll() {
    return this.catalogService.getAllSystems();
  }

  @Post()
  async save(@Body() body: { name: string; sheets: any[]; folderId?: string | null }) {
    return this.catalogService.saveSystem(body.name, body.sheets, body.folderId);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.catalogService.deleteSystem(id);
  }
}
