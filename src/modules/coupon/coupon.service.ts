import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import axios from 'axios';
import { Model } from 'mongoose';
import { Coupon } from './schema/coupon.schema';

@Injectable()
export class CouponService {
  constructor(
    @InjectModel(Coupon.name)
    private couponModel: Model<Coupon>,
  ) {}

  // Create coupon (Postman)
  async createCoupon(dto: any) {
    return this.couponModel.create(dto);
  }

  // Get visible coupons (Frontend)
  async getAvailableCoupons() {
    return this.couponModel.find({ show: true });
  }

  // Validate coupon (IMPORTANT)
  async validateCoupon(name: string) {
    const coupon = await this.couponModel.findOne({ name });

    if (!coupon) {
      throw new NotFoundException('Invalid coupon');
    }

    return coupon;
  }
}