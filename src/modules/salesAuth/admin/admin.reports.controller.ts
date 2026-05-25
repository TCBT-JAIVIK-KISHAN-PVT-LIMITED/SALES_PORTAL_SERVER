import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Salesperson } from '../models/salesperson.schema';
import { SalesDocument } from '../models/sales-document.schema';
import { SalesAdminGuard } from '../guards/sales-admin.guard';

@Controller('sales-auth/admin')
export class SalesAdminReportsController {
  constructor(
    @InjectModel(Salesperson.name)
    private readonly salespersonModel: Model<Salesperson>,
    @InjectModel(SalesDocument.name)
    private readonly salesDocumentModel: Model<SalesDocument>,
  ) {}

  @UseGuards(SalesAdminGuard)
  @Get('salespeople')
  async getSalespeople() {
    const salespeople = await this.salespersonModel.find().lean() as any[];

    const invoiceStats = await this.salesDocumentModel.aggregate([
      {
        $match: {
          type: 'invoice',
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

    const payload = (salespeople as any[]).map(sp => ({
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
    }));

    return {
      data: payload,
      total: payload.length,
    };
  }

  @UseGuards(SalesAdminGuard)
  @Get('salespeople/:salespersonId/invoices')
  async getSalespersonPaidInvoices(@Param('salespersonId') salespersonId: string) {
    const invoices = await this.salesDocumentModel
      .find({
        salesperson_id: salespersonId.trim(),
        type: 'invoice',
      })
      .sort({ createdAt: -1 })
      .lean() as any[];

    return {
      data: invoices.map(invoice => ({
        id: invoice._id.toString(),
        salespersonId: invoice.salesperson_id,
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

  @UseGuards(SalesAdminGuard)
  @Get('sales-invoices')
  async getInvoices(@Query('salespersonId') salespersonId?: string) {
    const query: any = {
      type: 'invoice',
    };

    if (salespersonId) {
      query.salesperson_id = salespersonId.trim();
    }

    const invoices = await this.salesDocumentModel.find(query).sort({ createdAt: -1 }).lean() as any[];

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
}
