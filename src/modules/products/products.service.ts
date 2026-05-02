import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Product } from './schemas/product.schema';
import { Model } from 'mongoose';
import { ZohoInventoryService } from '../../zoho/inventory/inventory.service';
import { ZohoImageSyncService } from '../../integrations/zoho-image-sync/zoho-image-sync.service';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectModel(Product.name)
    private productModel: Model<Product>,
    private zohoInventoryService: ZohoInventoryService,
    private zohoImageSyncService: ZohoImageSyncService,
  ) { }

  // 🔁 Daily safety net sync at 2AM — catches anything webhooks missed
  @Cron('0 0 2 * * *')
  async syncZohoProducts() {
    this.logger.log('🔄 Starting daily safety net sync...');

    try {
      let page = 1;
      const perPage = 200;
      let hasMore = true;
      let synced = 0;
      let failed = 0;

      while (hasMore) {
        const response = await this.zohoInventoryService.getItems(page, perPage);
        const items = response.items || [];

        this.logger.log(`📦 Page ${page} — ${items.length} items`);

        for (const item of items) {
          try {
            // ✅ Full sync — product details + image in one call
            await this.zohoImageSyncService.syncItemImage(item.item_id);

            // ✅ Small delay to avoid Zoho rate limits
            await new Promise((res) => setTimeout(res, 300));
            synced++;
          } catch (error: any) {
            this.logger.error(`Failed to sync ${item.item_id}: ${error.message}`);
            failed++;
          }
        }

        hasMore = items.length === perPage;
        page++;
      }

      this.logger.log(
        `✅ Daily sync completed — synced: ${synced}, failed: ${failed}`,
      );
    } catch (error: any) {
      this.logger.error(`Daily sync failed: ${error.message}`);
    }
  }

  // 🔹 Get all active products
  async getActiveProducts() {

    const products = await this.productModel
      .find({
        is_active: true,
        show_in_storefront: true,
      })
      .select('name price stock description image category_name show_in_storefront')
      .lean();

    const total = await this.productModel.countDocuments({
      is_active: true,
      show_in_storefront: true,
    });

    return {
      data: products,
      total: products.length,
      totalInDB: total,
    };
  }

  // 🔹 Get single product
  async getProductById(id: string) {
    const product = await this.productModel
      .findOne({
        $or: [{ _id: id }, { zoho_item_id: id }],
      })
      .lean();

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  // 🔹 Filtered products
  async getFilteredProducts(query: any) {
    let { page = 1, limit = 20, category, minPrice, maxPrice, search } = query;

    page = Number(page);
    limit = Math.min(Number(limit), 50);

    const filter: any = {
      is_active: true,
      show_in_storefront: true,
    };

    if (category) {
      filter.$and = [
        {
          $or: [{ category_id: category }, { category_name: category }],
        },
      ];
    }

    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }

    const skip = (page - 1) * limit;

    const products = await this.productModel
      .find(filter)
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await this.productModel.countDocuments(filter);

    return {
      data: products,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}