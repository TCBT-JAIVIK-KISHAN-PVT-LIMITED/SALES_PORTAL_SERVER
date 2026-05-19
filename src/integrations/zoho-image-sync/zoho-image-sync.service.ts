import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ZohoHttpService } from '../../zoho/core/zoho-http.service';
import { ZohoAuthService } from '../../zoho/core/zoho-auth.service';
import { S3UploadService } from '../../common/s3-upload.service';
import { ConfigService } from '@nestjs/config';
import { Product } from '../../modules/products/schemas/product.schema';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

@Injectable()
export class ZohoImageSyncService {
  private readonly logger = new Logger(ZohoImageSyncService.name);

  constructor(
    private readonly zohoHttpService: ZohoHttpService,
    private readonly zohoAuthService: ZohoAuthService,
    private readonly s3UploadService: S3UploadService,
    private readonly configService: ConfigService,
    @InjectModel(Product.name)
    private readonly productModel: Model<Product>,
  ) { }

  // =====================
  // 🗑️ DELETE ITEM
  // =====================
  async deleteItem(itemId: string): Promise<void> {
    this.logger.log(`🗑️ Deleting item: ${itemId}`);

    const product = await this.productModel.findOne({ zoho_item_id: itemId });

    if (!product) {
      this.logger.warn(`⚠️ Item ${itemId} not found in DB — nothing to delete`);
      return;
    }

    // ✅ FIX: support both flat and nested image key
    const s3Key = (product as any).image?.image_s3_key || (product as any).image_s3_key;
    if (s3Key) {
      await this.s3UploadService.deleteImage(s3Key);
    }

    try {
      await this.productModel.deleteOne({ zoho_item_id: itemId });
      this.logger.log(`✅ Item ${itemId} deleted from DB and S3`);
    } catch (err: any) {
      this.logger.error(`❌ MongoDB delete failed for ${itemId}: ${err.message}`);
      throw err;
    }
  }

  // =====================
  // 🔁 RETRY WRAPPER
  // =====================
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;

        const status = err?.response?.status ?? 0;

        // ✅ FIX: Don't retry 400 (bad request / no image) — it will never resolve
        if (status === 400) {
          this.logger.warn(
            `⛔ ${label} got 400 Bad Request — not retrying (item likely has no image in Zoho)`,
          );
          break;
        }

        // ✅ Don't retry 401/403 auth errors either
        if (status === 401 || status === 403) {
          this.logger.warn(`⛔ ${label} got ${status} Auth error — not retrying`);
          break;
        }

        const isRateLimit =
          status === 429 ||
          err?.message?.includes('429') ||
          err?.message?.includes('rate');

        const isTransient =
          err?.message?.includes('timeout') ||
          err?.message?.includes('ECONNRESET') ||
          err?.message?.includes('ETIMEDOUT') ||
          err?.message?.includes('socket');

        if ((isRateLimit || isTransient) && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          this.logger.warn(
            `⏳ ${label} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms... [${err.message}]`,
          );
          await new Promise((res) => setTimeout(res, delay));
        } else {
          this.logger.warn(
            `⚠️ ${label} failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`,
          );
          break;
        }
      }
    }

    throw lastError;
  }

  // =====================
  // 🔄 MAIN SYNC
  // =====================
  async syncItemImage(itemId: string): Promise<void> {
    this.logger.log(`🔄 Syncing item: ${itemId}`);

    const orgId = this.configService.getOrThrow('ZOHO_ORG_ID');

    // =====================
    // 1. FETCH ITEM
    // =====================
    const data = await this.withRetry(
      () =>
        this.zohoHttpService.request(
          'GET',
          `https://www.zohoapis.in/inventory/v1/items/${itemId}?organization_id=${orgId}`,
          'inventory',
        ),
      'Fetch item',
    );

    const item = data?.item;
    if (!item) {
      this.logger.warn(`⚠️ Item ${itemId} not found in Zoho`);
      return;
    }

    // =====================
    // 2. HANDLE INACTIVE
    // =====================
    if (item.status !== 'active') {
      this.logger.warn(
        `⛔ Skipping item ${itemId} — status is ${item.status}`,
      );
      return;
    }

    // =====================
    // 3. EXISTING PRODUCT
    // =====================
    const existingProduct = await this.productModel.findOne({
      zoho_item_id: String(itemId),
    });

    const isNewProduct = !existingProduct;

    const existingImage = existingProduct?.image || null;
    const existingImageHash = existingImage?.image_hash;
    const existingImageName = existingImage?.image_name;
    const existingImageS3Key = existingImage?.image_s3_key;

    // =====================
    // 4. BUILD CLEAN DATA
    // =====================
    const pkg = item.package_details || {};

    const productData: any = {
      zoho_item_id: String(itemId),

      name: item.name || '',
      description: item.description || '',
      sku: item.sku || '',

      price: item.rate || 0,
      stock: item.actual_available_stock ?? item.stock_on_hand ?? 0,
      unit: item.unit || item.unit_name || item.purchase_unit || '',

      category_id: item.category_id || '',
      category_name: item.category_name || '',

      weight: pkg.weight ?? 0,
      weight_unit: pkg.weight_unit || 'kg',

      dimensions: pkg.length
        ? `${pkg.length} ${pkg.dimension_unit} x ${pkg.width} ${pkg.dimension_unit} x ${pkg.height} ${pkg.dimension_unit}`
        : '',

      is_active: true,

      // ✅ New products default to visible; existing products keep their current value.
      // The daily cron / startup sync will correct this using the Storefront API.
      ...(isNewProduct ? { show_in_storefront: true } : {}),
    };

    const imageName = item?.image_name;

    // =====================
    // 5. IMAGE REMOVED
    // =====================
    if (!imageName && existingImageS3Key) {
      this.logger.warn(`🗑️ Image removed for item ${itemId}`);

      await this.s3UploadService.deleteImage(existingImageS3Key);

      await this.productModel.findOneAndUpdate(
        { zoho_item_id: String(itemId) },
        {
          ...productData,
          $unset: { image: "" },
        },
        { upsert: true },
      );

      return;
    }

    // =====================
    // 6. NO IMAGE CASE
    // =====================
    if (!imageName) {
      await this.productModel.findOneAndUpdate(
        { zoho_item_id: String(itemId) },
        productData,
        { upsert: true },
      );

      return;
    }

    // =====================
    // 7. IMAGE CHANGE CHECK
    // =====================
    const imageNameChanged = existingImageName !== imageName;

    // =====================
    // 8. UPLOAD IMAGE
    // =====================
    const imageUrl = `https://www.zohoapis.in/inventory/v1/items/${itemId}/image?organization_id=${orgId}`;
    const token = await this.zohoAuthService.getValidAccessToken('inventory');

    let uploadResult;

    try {
      uploadResult = await this.withRetry(
        () =>
          this.s3UploadService.uploadImageFromUrl(
            imageUrl,
            itemId,
            token,
            imageNameChanged || isNewProduct ? undefined : existingImageHash,
          ),
        'S3 upload',
      );
    } catch (err: any) {
      this.logger.error(`❌ S3 failed for ${itemId}: ${err.message}`);

      // fallback: save product only
      await this.productModel.findOneAndUpdate(
        { zoho_item_id: String(itemId) },
        productData,
        { upsert: true },
      );

      return;
    }

    const { s3Url, s3Key, imageHash, skipped } = uploadResult;

    // =====================
    // 9. IMAGE UNCHANGED
    // =====================
    if (skipped) {
      await this.productModel.findOneAndUpdate(
        { zoho_item_id: String(itemId) },
        productData,
        { upsert: true },
      );

      return;
    }

    // =====================
    // 10. DELETE OLD IMAGE
    // =====================
    if (imageNameChanged && existingImageS3Key) {
      await this.s3UploadService.deleteImage(existingImageS3Key);
    }

    // =====================
    // 11. FINAL SAVE
    // =====================
    await this.productModel.findOneAndUpdate(
      { zoho_item_id: String(itemId) },
      {
        ...productData,
        image: {
          image_url: s3Url,
          image_s3_key: s3Key,
          image_hash: imageHash,
          image_name: imageName,
          image_last_synced_at: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    this.logger.log(
      `✅ ${isNewProduct ? 'Created' : 'Updated'} product ${itemId}`,
    );
  }
}
