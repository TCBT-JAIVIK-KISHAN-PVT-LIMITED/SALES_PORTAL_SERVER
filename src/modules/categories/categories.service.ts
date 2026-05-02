import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Category } from './schemas/category.schema';
import { Product } from '../products/schemas/product.schema';
import { Model } from 'mongoose';

@Injectable()
export class CategoryService {
  constructor(
    @InjectModel(Category.name)
    private categoryModel: Model<Category>,

    @InjectModel(Product.name)
    private productModel: Model<Product>,
  ) {}

  // 🔥 SYNC CATEGORIES FROM PRODUCTS
  async syncCategories() {
    const categories = await this.productModel.aggregate([
      {
        $match: {
          is_active: true,
          show_in_storefront: true,
        },
      },
      {
        $group: {
          _id: '$category_id',
          name: { $first: '$category_name' },
        },
      },
    ]);

    for (const cat of categories) {
      await this.categoryModel.updateOne(
        { category_id: cat._id },
        {
          $set: {
            name: cat.name,
            is_active: true,
          },
        },
        { upsert: true },
      );
    }

    return {
      message: 'Categories synced successfully',
      count: categories.length,
    };
  }

  // 🔥 GET ALL CATEGORIES
  async getAllCategories() {
    return this.categoryModel
      .find({ is_active: true })
      .select('category_id name')
      .lean();
  }
}