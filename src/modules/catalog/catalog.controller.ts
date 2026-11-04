import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';

@Controller('api/catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  async getAll() {
    return this.catalogService.getAllSystems();
  }

  @Post()
  async save(@Body() body: { name: string; sheets: any[] }) {
    return this.catalogService.saveSystem(body.name, body.sheets);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.catalogService.deleteSystem(id);
  }
}
