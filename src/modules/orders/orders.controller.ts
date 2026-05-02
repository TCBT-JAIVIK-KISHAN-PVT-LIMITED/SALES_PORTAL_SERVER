import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
  Body,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) { }

  @Post()
  async createOrder(@Req() req: any, @Body() body: any) {
    const userId = req.user.userId;

    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    return this.ordersService.createOrderFromCart(
      userId,
      body.addressId,
      body.couponId,
    );
  }

  @Get()
  async getOrders(
    @Req() req: any,
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    const userId = req.user.userId;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Number(limit));
    return this.ordersService.getOrders(userId, pageNum, limitNum);
  }

  @Get(':orderId')
  async getOrder(@Req() req: any, @Param('orderId') orderId: string) {
    const userId = req.user.userId;
    return this.ordersService.getOrderById(userId, orderId);
  }

  @Patch(':orderId/cancel')
  async cancelOrder(@Req() req: any, @Param('orderId') orderId: string) {
    const userId = req.user.userId;

    if (!userId) {
      throw new Error('Unauthorized');
    }

    return this.ordersService.cancelOrder(userId, orderId);
  }
}