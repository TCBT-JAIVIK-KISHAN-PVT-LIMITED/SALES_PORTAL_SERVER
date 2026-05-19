import { Injectable, NotFoundException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Product } from './schemas/product.schema';
import { Model, isValidObjectId } from 'mongoose';
import { ZohoInventoryService } from '../../zoho/inventory/inventory.service';
import { ZohoImageSyncService } from '../../integrations/zoho-image-sync/zoho-image-sync.service';
import { ZohoCommerceStorefrontService } from '../../zoho/commerce/commerce-storefront.service';

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectModel(Product.name)
    private productModel: Model<Product>,
    private zohoInventoryService: ZohoInventoryService,
    private zohoImageSyncService: ZohoImageSyncService,
    private storefrontService: ZohoCommerceStorefrontService,
  ) { }

  /**
   * 🚀 Startup migration — runs once when the server boots.
   * 
   * 1. Backfills show_in_storefront for any existing products that
   *    don't have the field yet (sets to true so they remain visible).
   * 2. Immediately syncs storefront visibility from the Storefront API
   *    so products get the correct value before any user request hits.
   */
  async onModuleInit() {
    this.logger.log('🚀 Running startup storefront visibility sync...');

    try {
      // Step 1: Backfill — set show_in_storefront = true for docs that lack the field.
      // This prevents ALL products from vanishing before the Storefront API responds.
      const backfillResult = await this.productModel.updateMany(
        { show_in_storefront: { $exists: false } },
        { $set: { show_in_storefront: true } },
      );

      if (backfillResult.modifiedCount > 0) {
        this.logger.log(
          `📦 Backfilled show_in_storefront for ${backfillResult.modifiedCount} existing products`,
        );
      }

      // Step 2: Immediately sync from Storefront API to set correct values.
      const publishedIds = await this.storefrontService.getAllPublishedProductIds();

      if (publishedIds.size > 0) {
        await this.productModel.updateMany(
          { zoho_item_id: { $in: [...publishedIds] } },
          { $set: { show_in_storefront: true } },
        );

        await this.productModel.updateMany(
          { zoho_item_id: { $nin: [...publishedIds] } },
          { $set: { show_in_storefront: false } },
        );

        this.logger.log(
          `✅ Startup storefront sync complete — ${publishedIds.size} products visible`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `⚠️ Startup storefront sync failed (products remain visible): ${error.message}`,
      );
      // If Storefront API fails on startup, products stay visible (backfilled to true).
      // The daily cron will fix it later.
    }
  }

  // 🔁 Daily safety net sync at 2AM — catches anything webhooks missed
  @Cron('0 0 2 * * *')
  async syncZohoProducts() {
    this.logger.log('🔄 Starting daily safety net sync...');

    try {
      // =============================================
      // STEP 1: Fetch published product IDs from Commerce Storefront API
      // =============================================
      let publishedIds: Set<string> = new Set();

      try {
        publishedIds = await this.storefrontService.getAllPublishedProductIds();
        this.logger.log(
          `🛒 Storefront API returned ${publishedIds.size} published product IDs`,
        );
      } catch (error: any) {
        this.logger.error(
          `⚠️ Storefront API failed, will skip show_in_storefront update: ${error.message}`,
        );
      }

      // =============================================
      // STEP 2: Sync all inventory items (product data + images)
      // =============================================
      let page = 1;
      const perPage = 200;
      let hasMore = true;
      let synced = 0;
      let failed = 0;
      const syncedItemIds: string[] = [];

      while (hasMore) {
        const response = await this.zohoInventoryService.getItems(page, perPage);
        const items = response.items || [];

        this.logger.log(`📦 Page ${page} — ${items.length} items`);

        for (const item of items) {
          try {
            // ✅ Full sync — product details + image in one call
            await this.zohoImageSyncService.syncItemImage(item.item_id);
            syncedItemIds.push(String(item.item_id));

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

      // =============================================
      // STEP 3: Update show_in_storefront based on Storefront API data
      // =============================================
      if (publishedIds.size > 0) {
        // Mark products visible on storefront
        const visibleResult = await this.productModel.updateMany(
          { zoho_item_id: { $in: [...publishedIds] } },
          { $set: { show_in_storefront: true } },
        );

        // Mark products NOT visible on storefront
        const hiddenResult = await this.productModel.updateMany(
          { zoho_item_id: { $nin: [...publishedIds] } },
          { $set: { show_in_storefront: false } },
        );

        this.logger.log(
          `🛒 Storefront visibility updated — visible: ${visibleResult.modifiedCount}, hidden: ${hiddenResult.modifiedCount}`,
        );
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
      .select(
        'name price stock unit description image category_name sku weight weight_unit dimensions zoho_item_id show_in_storefront',
      )
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
    const query = isValidObjectId(id)
      ? { $or: [{ _id: id }, { zoho_item_id: id }] }
      : { zoho_item_id: id };

    const product = await this.productModel.findOne(query).lean();

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
