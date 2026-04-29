import { Injectable } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { ConfigService } from '@nestjs/config';
import { ZohoPaymentsService } from '../../zoho/payments/payments.service';

@Injectable()
export class ZohoPaymentGatewayService {
  constructor(
    private readonly zohoPaymentsService: ZohoPaymentsService,
    private readonly configService: ConfigService,
  ) { }

  // 💳 CREATE PAYMENT SESSION
  async createPaymentSession(order: any) {
    const accessToken =
      await this.zohoPaymentsService.getValidAccessToken();

    const accountId = this.configService.get<string>(
      'ZOHO_PAYMENTS_ACCOUNT_ID',
    );

    const payload = {
      amount: order.finalAmount,
      currency: 'INR',
      description: `Order ${order.orderId}`,
      invoice_number: order.orderId,
      reference_number: order.orderId,
      max_retry_count: 3,
    };

    try {
      const response = await axios.post(
        `https://payments.zoho.in/api/v1/paymentsessions?account_id=${accountId}`, // ✅ FIXED
        payload,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data.payments_session; // ✅ FIXED
    } catch (error: unknown) {
      const err = error as AxiosError;
      console.error(
        'Zoho Payment Session Error:',
        err.response?.data || err.message,
      );
      throw error;
    }
  }

  // 🔍 GET SESSION
  async getPaymentSession(sessionId: string) {
    const accessToken =
      await this.zohoPaymentsService.getValidAccessToken();

    const accountId = this.configService.get<string>(
      'ZOHO_PAYMENTS_ACCOUNT_ID',
    );

    try {
      const response = await axios.get(
        `https://payments.zoho.in/api/v1/paymentsessions/${sessionId}?account_id=${accountId}`, // ✅ FIXED
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
          },
        },
      );

      return response.data;
    } catch (error: unknown) {
      const err = error as AxiosError;
      console.error(
        'Zoho Payment Status Error:',
        err.response?.data || err.message,
      );
      throw error;
    }
  }

  async verifyPaymentSessionStatus(sessionId: string): Promise<{
    status: string;
    paymentId: string | null;
    amount: string | null;
  }> {
    const data = await this.getPaymentSession(sessionId);
    const session = data?.payments_session;

    const succeededPayment = session?.payments?.find(
      (p: any) => p.status === 'succeeded',
    );

    return {
      status: session?.status ?? 'unknown',
      paymentId: succeededPayment?.payment_id ?? null,
      amount: session?.amount ?? null,
    };
  }

  // 💸 REFUND
  async refundPayment(paymentId: string, amount: number) {
    const accessToken =
      await this.zohoPaymentsService.getValidAccessToken();

    const accountId = this.configService.get<string>(
      'ZOHO_PAYMENTS_ACCOUNT_ID',
    );

    try {
      const response = await axios.post(
        `https://payments.zoho.in/api/v1/payments/${paymentId}/refunds?account_id=${accountId}`,
        { amount },
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
          },
        },
      );

      return response.data;
    } catch (error: unknown) {
      const err = error as AxiosError;
      console.error(
        'Zoho Refund Error:',
        err.response?.data || err.message,
      );
      throw error;
    }
  }
}