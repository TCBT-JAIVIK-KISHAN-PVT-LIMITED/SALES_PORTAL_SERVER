import { Body, Controller, Get, Post } from "@nestjs/common";
import { CouponService } from "./coupon.service";

@Controller('coupon')
export class CouponController {
  constructor(private couponService: CouponService) {}

  @Post()
  create(@Body() body: any) {
    return this.couponService.createCoupon(body);
  }

  @Get()
  getAll() {
    return this.couponService.getAvailableCoupons();
  }

  @Post('validate')
  validate(@Body('code') code: string) {
    return this.couponService.validateCoupon(code);
  }
}