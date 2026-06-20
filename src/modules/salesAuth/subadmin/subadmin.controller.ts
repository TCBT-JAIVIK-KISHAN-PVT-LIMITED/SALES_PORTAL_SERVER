import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CurrentSalesUser } from '../decorators/current-sales-user.decorator';
import { RolesGuard } from '../guards/roles.guard';
import { HierarchyGuard } from '../guards/hierarchy.guard';
import { Roles } from '../decorators/roles.decorator';
import { SalesAuthService } from '../salesAuth.service';
import { Salesperson } from '../models/salesperson.schema';
import { SalesDocument } from '../models/sales-document.schema';
import { SubAdminLoginDto } from '../dto/subadmin-login.dto';
import { CreateSalespersonDto } from '../dto/create-salesperson.dto';
import { Order } from '../salesOrders/schemas/order.schema';

@Controller('sales-auth/subadmin')
export class SubAdminController {
  constructor(
    private salesAuthService: SalesAuthService,
    @InjectModel(Salesperson.name)
    private readonly salespersonModel: Model<Salesperson>,
    @InjectModel(SalesDocument.name)
    private readonly salesDocumentModel: Model<SalesDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<Order>,
  ) {}

  @Post('login')
  login(@Body() dto: SubAdminLoginDto) {
    return this.salesAuthService.loginSubAdmin(dto);
  }

  @UseGuards(RolesGuard)
  @Roles('subadmin')
  @Get('team')
  async getTeamMembers(@CurrentSalesUser() subadmin: { login_id: string }) {
    const salespeople = await this.salespersonModel
      .find({ assigned_subadmin_id: subadmin.login_id })
      .lean();

    const salespersonIds = salespeople.map(sp => sp.salesperson_id);

    const invoiceStats = await this.salesDocumentModel.aggregate([
      {
        $match: {
          type: 'invoice',
          salesperson_id: { $in: salespersonIds },
        },
      },
      {
        $group: {
          _id: '$salesperson_id',
          paidInvoices: { $sum: 1 },
          totalRevenue: { $sum: '$grandTotal' },
          lastInvoiceAt: { $max: '$createdAt' },
        },
      },
    ]);

    const statsBySalesperson = invoiceStats.reduce((acc, stat) => {
      acc[stat._id] = stat;
      return acc;
    }, {} as Record<string, { paidInvoices: number; totalRevenue: number; lastInvoiceAt: Date }>);

    return {
      data: salespeople.map((sp: any) => ({
        id: sp._id.toString(),
        salesId: sp.salesperson_id,
        name: sp.name,
        email: sp.email || undefined,
        phone: sp.mobile_number || undefined,
        isActive: sp.is_active,
        createdAt: sp.created_at ? new Date(sp.created_at).toISOString() : undefined,
        lastLoginAt: sp.last_login_at ? new Date(sp.last_login_at).toISOString() : undefined,
        invoiceStats: {
          paidInvoices: statsBySalesperson[sp.salesperson_id]?.paidInvoices ?? 0,
          totalRevenue: statsBySalesperson[sp.salesperson_id]?.totalRevenue ?? 0,
          lastInvoiceAt: statsBySalesperson[sp.salesperson_id]?.lastInvoiceAt
            ? new Date(statsBySalesperson[sp.salesperson_id].lastInvoiceAt).toISOString()
            : undefined,
        },
      })),
      total: salespeople.length,
    };
  }

  @UseGuards(RolesGuard)
  @Roles('subadmin')
  @Post('salespeople')
  async createSalesperson(
    @Body() dto: CreateSalespersonDto,
    @CurrentSalesUser() subadmin: { login_id: string, sub: string },
  ) {
    // Sub Admin creates a salesperson, auto-assigning them to their team
    const result = await this.salesAuthService.createSalesperson(dto, {
      sub: subadmin.sub,
      login_id: subadmin.login_id,
    });

    await this.salespersonModel.updateOne(
      { salesperson_id: dto.salesperson_id.trim() },
      { $set: { assigned_subadmin_id: subadmin.login_id } },
    );

    return {
      ...result,
      salesperson: {
        ...result.salesperson,
        assigned_subadmin_id: subadmin.login_id,
      },
    };
  }

  @UseGuards(RolesGuard, HierarchyGuard)
  @Roles('subadmin')
  @Patch('salespeople/:salespersonId')
  async editSalesperson(
    @Param('salespersonId') salespersonId: string,
    @Body() body: any,
    @CurrentSalesUser() subadmin: { login_id: string },
  ) {
    const salesperson = await this.salespersonModel.findOne({
      salesperson_id: salespersonId.trim(),
      assigned_subadmin_id: subadmin.login_id,
    });

    if (!salesperson) {
      throw new NotFoundException(
        'Salesperson not found or does not belong to your team',
      );
    }

    if (body.name) salesperson.name = body.name.trim();
    if (body.email) salesperson.email = body.email.trim().toLowerCase();
    if (body.phone || body.mobile_number) salesperson.mobile_number = (body.phone || body.mobile_number).trim();
    if (body.is_active !== undefined) salesperson.is_active = body.is_active;

    await salesperson.save();

    return {
      message: 'Salesperson updated successfully',
      salesperson: {
        id: salesperson._id.toString(),
        salesId: salesperson.salesperson_id,
        name: salesperson.name,
        email: salesperson.email,
        phone: salesperson.mobile_number,
        isActive: salesperson.is_active,
        assigned_subadmin_id: salesperson.assigned_subadmin_id,
      },
    };
  }

  @UseGuards(RolesGuard, HierarchyGuard)
  @Roles('subadmin')
  @Delete('salespeople/:salespersonId')
  async deleteSalesperson(
    @Param('salespersonId') salespersonId: string,
    @CurrentSalesUser() subadmin: { login_id: string },
  ) {
    const salesperson = await this.salespersonModel.findOne({
      salesperson_id: salespersonId.trim(),
      assigned_subadmin_id: subadmin.login_id,
    });

    if (!salesperson) {
      throw new NotFoundException(
        'Salesperson not found or does not belong to your team',
      );
    }

    return this.salesAuthService.deleteSalesperson(salespersonId);
  }

  @UseGuards(RolesGuard, HierarchyGuard)
  @Roles('subadmin')
  @Get('invoices')
  async getTeamInvoices(
    @CurrentSalesUser() subadmin: { login_id: string },
    @Query('salespersonId') salespersonId?: string,
    @Query('type') type?: string,
  ) {
    const salespeople = await this.salespersonModel
      .find({ assigned_subadmin_id: subadmin.login_id })
      .lean();

    const salespersonIds = salespeople.map(sp => sp.salesperson_id);

    const query: any = {
      type: type === 'quotation' ? 'quotation' : 'invoice',
      salesperson_id: { $in: salespersonIds },
    };

    if (salespersonId) {
      const trimmedSpId = salespersonId.trim();
      if (!salespersonIds.includes(trimmedSpId)) {
        throw new UnauthorizedException(
          'Cannot access invoices for salespersons outside your team',
        );
      }
      query.salesperson_id = trimmedSpId;
    }

    const invoices = await this.salesDocumentModel
      .find(query)
      .sort({ createdAt: -1 })
      .lean() as any[];

    return {
      data: invoices.map(invoice => ({
        id: invoice._id.toString(),
        salesId: invoice.salesperson_id,
        salesName: invoice.salesName,
        documentNumber: invoice.documentNumber,
        quoteNumber: invoice.data?.quoteNumber || invoice.documentNumber,
        customerName: invoice.customerName,
        customerPhone: invoice.customerPhone,
        subtotal: invoice.subtotal,
        gst: invoice.gst,
        grandTotal: invoice.grandTotal,
        items: invoice.items,
        paymentMethod: invoice.data?.paymentMethod || null,
        paymentDate: invoice.data?.paymentDate || null,
        transactionId: invoice.data?.transactionId || null,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
      })),
      total: invoices.length,
    };
  }

  @UseGuards(RolesGuard, HierarchyGuard)
  @Roles('subadmin')
  @Get('orders')
  async getTeamOrders(
    @CurrentSalesUser() subadmin: { login_id: string },
    @Query('salespersonId') salespersonId?: string,
  ) {
    const salespeople = await this.salespersonModel
      .find({ assigned_subadmin_id: subadmin.login_id })
      .lean();

    const salespersonIds = salespeople.map(sp => sp.salesperson_id);

    const query: any = {
      salesId: { $in: salespersonIds },
    };

    if (salespersonId) {
      const trimmedSpId = salespersonId.trim();
      if (!salespersonIds.includes(trimmedSpId)) {
        throw new UnauthorizedException(
          'Cannot access orders for salespersons outside your team',
        );
      }
      query.salesId = trimmedSpId;
    }

    const orders = await this.orderModel
      .find(query)
      .sort({ createdAt: -1 })
      .lean() as any[];

    return {
      data: orders,
      total: orders.length,
    };
  }

  @UseGuards(RolesGuard)
  @Roles('subadmin')
  @Get('performance')
  async getTeamPerformance(@CurrentSalesUser() subadmin: { login_id: string }) {
    const salespeople = await this.salespersonModel
      .find({ assigned_subadmin_id: subadmin.login_id })
      .lean();

    const salespersonIds = salespeople.map(sp => sp.salesperson_id);

    const stats = await this.salesDocumentModel.aggregate([
      {
        $match: {
          type: 'invoice',
          salesperson_id: { $in: salespersonIds },
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$grandTotal' },
          totalOrders: { $sum: 1 },
        },
      },
    ]);

    const activeCount = salespeople.filter(sp => sp.is_active).length;

    return {
      totalRevenue: stats[0]?.totalRevenue ?? 0,
      totalOrders: stats[0]?.totalOrders ?? 0,
      teamSize: salespeople.length,
      activeSalespeople: activeCount,
    };
  }
}
