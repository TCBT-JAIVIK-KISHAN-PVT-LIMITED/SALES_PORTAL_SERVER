import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Product } from '../../products/schemas/product.schema';
import { ZohoInventoryService } from '../../../zoho/inventory/inventory.service';
import { CurrentSalesUser } from '../decorators/current-sales-user.decorator';
import { SalespersonLoginDto } from '../dto/salesperson-login.dto';
import { SalesDocument } from '../models/sales-document.schema';
import { SalespersonGuard } from '../guards/salesperson.guard';
import { SalesAuthService } from '../salesAuth.service';

@Controller('sales-auth/salesperson')
export class SalesController {
  constructor(
    private salesAuthService: SalesAuthService,
    @InjectModel(Product.name)
    private productModel: Model<Product>,
    @InjectModel(SalesDocument.name)
    private salesDocumentModel: Model<SalesDocument>,
    private zohoInventoryService: ZohoInventoryService,
  ) {}

  @Post('login')
  login(@Body() dto: SalespersonLoginDto) {
    return this.salesAuthService.loginSalesperson(dto);
  }

  @UseGuards(SalespersonGuard)
  @Get('products')
  async getProductsForSalesperson() {
    await this.safeRefreshStockAndUnitsFromZoho();

    const products = await this.productModel
      .find({
        is_active: true,
        show_in_storefront: true,
      })
      .select(
        'name price stock unit description image category_name sku weight weight_unit dimensions zoho_item_id show_in_storefront',
      )
      .lean();

    return {
      data: products,
      total: products.length,
    };
  }

  @UseGuards(SalespersonGuard)
  @Get('products/:id')
  async getProductForSalesperson(@Param('id') id: string) {
    await this.safeRefreshStockAndUnitsFromZoho();

    const query = isValidObjectId(id)
      ? { $or: [{ _id: id }, { zoho_item_id: id }] }
      : { zoho_item_id: id };

    const product = await this.productModel.findOne(query).lean();

    if (!product) {
      throw new BadRequestException('Product not found');
    }

    return product;
  }

  @UseGuards(SalespersonGuard)
  @Post('documents')
  async saveDocument(
    @Body() body: any,
    @CurrentSalesUser() salesperson: { login_id: string },
  ) {
    const type =
      body?.type === 'invoice' ? 'invoice' : 'quotation';
    const documentNumber = String(
      body?.documentNumber || body?.quoteNumber || '',
    ).trim(); 

    if (!documentNumber) {
      throw new BadRequestException('Document number is required');
    }

    const data = {
      ...body,
      type,
      documentNumber,
      quoteNumber: body?.quoteNumber || documentNumber,
      salesId: salesperson.login_id,
    };

    if (Array.isArray(data.items)) {
      delete data.items;
    }

    const existingDocument: any = await this.salesDocumentModel.findOne({
      salesperson_id: salesperson.login_id,
      type,
      documentNumber,
    });

    let zohoSalesOrderId = existingDocument?.zohoSalesOrderId;
    let isSyncedToZoho = existingDocument?.isSyncedToZoho || false;
    let zohoSyncError = existingDocument?.zohoSyncError;

    if (type === 'invoice' && !existingDocument?.isSyncedToZoho) {
      try {
        zohoSalesOrderId = await this.createZohoSalesOrderAndReduceStock(data);
        isSyncedToZoho = Boolean(zohoSalesOrderId);
        zohoSyncError = undefined;
      } catch (error: any) {
        throw new BadRequestException(
          error?.message || 'Unable to reduce Zoho inventory',
        );
      }
    }

    const document = await this.salesDocumentModel.findOneAndUpdate(
      {
        salesperson_id: salesperson.login_id,
        type,
        documentNumber,
      },
      {
        $set: {
          salesperson_id: salesperson.login_id,
          salesName: body?.salesName || salesperson.login_id,
          type,
          documentNumber,
          relatedQuotationNumber: body?.relatedQuotationNumber,
          customerName: body?.customerName || '',
          customerPhone: body?.customerPhone || body?.mobile,
          subtotal: Number(body?.subtotal || 0),
          gst: Number(body?.gst || 0),
          grandTotal: Number(body?.grandTotal || 0),
          items: Array.isArray(body?.items) ? body.items : [],
          data,
          zohoSalesOrderId,
          isSyncedToZoho,
          zohoSyncError,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return document;
  }

  @UseGuards(SalespersonGuard)
  @Get('documents')
  async getDocuments(
    @CurrentSalesUser() salesperson: { login_id: string },
    @Query('type') type?: string,
    @Query('search') search?: string,
  ) {
    const filter: any = {
      salesperson_id: salesperson.login_id,
    };

    if (type === 'quotation' || type === 'invoice') {
      filter.type = type;
    }

    if (search?.trim()) {
      const q = search.trim();
      filter.$or = [
        { documentNumber: { $regex: q, $options: 'i' } },
        { customerName: { $regex: q, $options: 'i' } },
        { customerPhone: { $regex: q, $options: 'i' } },
      ];
    }

    const documents = await this.salesDocumentModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return {
      data: documents.map((document: any) => ({
        ...document.data,
        items: document.items || document.data?.items || [],
        id: document._id,
        type: document.type,
        documentNumber: document.documentNumber,
        zohoSalesOrderId: document.zohoSalesOrderId,
        isSyncedToZoho: document.isSyncedToZoho,
        quoteNumber: document.data?.quoteNumber || document.documentNumber,
        onlinePaymentUrl: document.onlinePaymentUrl,
        onlinePaymentExpiresAt: document.onlinePaymentExpiresAt,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      })),
      total: documents.length,
    };
  }

  @UseGuards(SalespersonGuard)
  @Get('documents/:documentNumber')
  async getDocument(
    @CurrentSalesUser() salesperson: { login_id: string },
    @Param('documentNumber') documentNumber: string,
    @Query('type') type?: string,
  ) {
    const document = await this.salesDocumentModel
      .findOne({
        salesperson_id: salesperson.login_id,
        documentNumber,
        ...(type === 'quotation' || type === 'invoice' ? { type } : {}),
      })
      .lean();

    const result: any = document;

    return result
      ? {
          ...result.data,
          items: result.items || result.data?.items || [],
          id: result._id,
          type: result.type,
          documentNumber: result.documentNumber,
          zohoSalesOrderId: result.zohoSalesOrderId,
          isSyncedToZoho: result.isSyncedToZoho,
          quoteNumber: result.data?.quoteNumber || result.documentNumber,
          onlinePaymentUrl: result.onlinePaymentUrl,
          onlinePaymentExpiresAt: result.onlinePaymentExpiresAt,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
        }
      : null;
  }

  private async refreshStockAndUnitsFromZoho() {
    let page = 1;
    const perPage = 200;
    let hasMore = true;
    const operations: any[] = [];

    while (hasMore) {
      const response = await this.zohoInventoryService.getItems(page, perPage);
      const items = response?.items || [];

      for (const item of items) {
        const zohoItemId = String(item.item_id || '');
        if (!zohoItemId) continue;

        operations.push({
          updateOne: {
            filter: { zoho_item_id: zohoItemId },
            update: {
              $set: {
                price: Number(item.rate || 0),
                stock: this.getZohoStock(item),
                unit: this.getZohoUnit(item),
                is_active: item.status ? item.status === 'active' : true,
              },
            },
          },
        });
      }

      hasMore = items.length === perPage;
      page++;
    }

    if (operations.length > 0) {
      await this.productModel.bulkWrite(operations, { ordered: false });
    }
  }

  private async safeRefreshStockAndUnitsFromZoho() {
    try {
      await this.refreshStockAndUnitsFromZoho();
    } catch (error: any) {
      console.warn('Zoho inventory refresh failed, falling back to local product data:', error?.message || error);
    }
  }

  private async createZohoSalesOrderAndReduceStock(invoice: any) {
    await this.refreshStockAndUnitsFromZoho();

    const processedItems = await Promise.all(
      (invoice.items || []).map(async (item: any) => {
        const product = await this.findProductForSalesItem(item);
        if (!product) {
          throw new Error(`Product not found: ${item.name || item.id}`);
        }

        const quantity = Number(item.quantity || 0);
        if (quantity <= 0) {
          throw new Error(`Invalid quantity for ${item.name || product.name}`);
        }

        if (Number(product.stock || 0) < quantity) {
          throw new Error(
            `${product.name} has only ${product.stock || 0} ${product.unit || product.weight_unit || 'units'} in stock`,
          );
        }

        return {
          product,
          quantity,
          zohoItemId: product.zoho_item_id,
          name: product.name,
          price: Number(product.price || item.rate || 0),
        };
      }),
    );

    const customerId =
      await this.zohoInventoryService.findOrCreateSalesCustomer(invoice);

    if (!customerId) {
      throw new Error('Unable to create/find Zoho customer');
    }

    const zohoSalesOrderId = await this.zohoInventoryService.createSalesOrder(
      {
        orderId: invoice.documentNumber || invoice.quoteNumber,
        items: processedItems.map((item) => ({
          zohoItemId: item.zohoItemId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
        })),
        shippingCharge: 0,
        address: {
          addressLine: this.limitZohoAddress(
            invoice.billingAddress ||
              invoice.addressLine ||
              invoice.village ||
              '',
          ),
          billingAddress: this.limitZohoAddress(
            invoice.billingAddress ||
              invoice.addressLine ||
              invoice.village ||
              '',
          ),
          city: invoice.district || '',
          state: invoice.state || '',
          pincode: invoice.pin || '',
          phone: invoice.customerPhone || invoice.mobile || '',
        },
      },
      customerId,
    );

    await Promise.all(
      processedItems.map((item) =>
        this.productModel.updateOne(
          { zoho_item_id: item.zohoItemId },
          { $inc: { stock: -item.quantity } },
        ),
      ),
    );

    return zohoSalesOrderId;
  }

  private async findProductForSalesItem(item: any) {
    const zohoItemId = item.zoho_item_id || item.zohoItemId || item.raw?.zoho_item_id;
    if (zohoItemId) {
      return this.productModel.findOne({ zoho_item_id: String(zohoItemId) });
    }

    return this.productModel.findById(item.id);
  }

  private getZohoStock(item: any) {
    return Number(
      item.actual_available_stock ??
        item.available_stock ??
        item.stock_available ??
        item.stock_on_hand ??
        0,
    );
  }

  private getZohoUnit(item: any) {
    return (
      item.unit ||
      item.unit_name ||
      item.purchase_unit ||
      item.sales_rate_unit ||
      item.package_details?.weight_unit ||
      ''
    );
  }

  private limitZohoAddress(value: any) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 99 ? normalized.slice(0, 99) : normalized;
  }
}
