import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  async sendOrderSuccessSMS(
    mobile: string,
    amount: number,
    orderId: string,
  ): Promise<void> {
    this.logger.log(`✅ SMS service started for order ${orderId} to mobile ${mobile}`);
    try {
      const res = await axios.post(
        'https://control.msg91.com/api/v5/oneapi/api/flow/order-sms/run',
        {
          data: {
            sendTo: [
              {
                to: [
                  {
                    mobiles: `+91${mobile}`,
                    variables: {
                      var1: { type: 'text', value: orderId },
                      var2: { type: 'text', value: amount.toString() },
                    },
                  },
                ],
              },
            ],
          },
        },
        {
          headers: {
            authkey: process.env.MSG91_AUTH_KEY,
            'Content-Type': 'application/json',
          },
        },
      );

      this.logger.log(`✅ SMS sent for order ${orderId}`, res.data);
    } catch (error: any) {
      this.logger.error(
        `❌ SMS failed for order ${orderId}`,
        error.response?.data || error.message,
      );

      // ❗ Do NOT throw (important for payment flow safety)
    }
  }
}