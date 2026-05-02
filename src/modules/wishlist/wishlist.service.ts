import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Wishlist, WishlistDocument } from './schema/wishlist.schema';
import { Model } from 'mongoose';
import { Product, ProductDocument } from '../products/schemas/product.schema';

@Injectable()
export class WishlistService {
  constructor(
    @InjectModel(Wishlist.name)
    private wishlistModel: Model<WishlistDocument>,

    @InjectModel(Product.name)
    private productModel: Model<ProductDocument>,
  ) { }

  async getWishlist(userId: string) {
    let wishlist = await this.wishlistModel.findOne({ userId });

    if (!wishlist) {
      wishlist = await this.wishlistModel.create({
        userId,
        items: [],
      });
    }

    // 🔥 Extract IDs
    const ids = wishlist.items.map((i) => i.zoho_item_id);

    // 🔥 Fetch products from local DB
    const products = await this.productModel.find({
      zoho_item_id: { $in: ids },
      is_active: true,
      show_in_storefront: true,
    });

    // 🔥 Map products
    const productMap = new Map(products.map((p) => [p.zoho_item_id, p]));

    // 🔥 Attach product data
    const items = wishlist.items.map((item) => ({
      zoho_item_id: item.zoho_item_id,
      product: productMap.get(item.zoho_item_id) || null,
    }));

    return {
      userId: wishlist.userId,
      items,
    };
  }

  async addToWishlist(userId: string, zoho_item_id: string) {
    return this.wishlistModel.findOneAndUpdate(
      { userId, 'items.zoho_item_id': { $ne: zoho_item_id } },
      {
        $push: {
          items: { zoho_item_id },
        },
      },
      { new: true, upsert: true },
    );
  }

  async removeFromWishlist(userId: string, zoho_item_id: string) {
    return this.wishlistModel.findOneAndUpdate(
      { userId },
      {
        $pull: {
          items: { zoho_item_id },
        },
      },
      { new: true },
    );
  }
}
