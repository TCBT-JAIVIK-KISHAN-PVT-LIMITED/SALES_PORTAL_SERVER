import { BadRequestException, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ProductsService } from './products.service';
import { isValidObjectId } from 'mongoose';

@Controller('products')
export class ProductsController {

  constructor(private productsService: ProductsService) { }

  @Get()
  async getProducts() {
    return this.productsService.getActiveProducts();
  }

  @Post('sync-all-now')
  async syncAllNow() {
    await this.productsService.syncZohoProducts();
    return { message: 'Full sync started' };
  }

  @Get('/id/:id')
  async getProduct(@Param('id') id: string) {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid product ID');
    }

    return this.productsService.getProductById(id);
  }

  @Get('/filter')
  async getFilteredProducts(@Query() query: any) {
    return this.productsService.getFilteredProducts(query);
  }
}
