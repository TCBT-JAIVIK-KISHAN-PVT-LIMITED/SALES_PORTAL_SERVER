import {
  Injectable,
  HttpException,
  Logger,
} from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);
  private axiosInstance: AxiosInstance;
  private readonly fallbackShippingCharge: number;

  constructor(private configService: ConfigService) {
    this.axiosInstance = axios.create({
      baseURL: this.configService.get<string>('SHIPMOZO_BASE_URL'),
      timeout: 5000,
    });
    this.fallbackShippingCharge = Math.ceil(
      Number(this.configService.get<string>('SHIPMOZO_FALLBACK_CHARGE') ?? 0),
    );
  }

  async calculateRate(
    weight: number,
    deliveryPincode: number,
    type_of_package: string,
  ) {
    const payload = {
      pickup_pincode: 482003,
      delivery_pincode: deliveryPincode,
      payment_type: 'PREPAID',
      shipment_type: 'FORWARD',
      order_amount: 1000,
      type_of_package,
      rov_type: 'ROV_OWNER',
      cod_amount: 0,
      weight,
      dimensions: [
        {
          no_of_box: 1,
          length: 22,
          width: 10,
          height: 10,
        },
      ],
    };

    try {
      const response = await this.axiosInstance.post(
        '/app/api/v1/rate-calculator',
        payload,
        {
          headers: {
            'public-key': this.configService.get<string>('SHIPMOZO_PUBLIC_KEY'),
            'private-key': this.configService.get<string>('SHIPMOZO_PRIVATE_KEY'),
            'Content-Type': 'application/json',
          },
        },
      );

      const rates = response?.data?.data || [];

      if (!rates.length) {
        this.logger.warn(
          'Shipping API returned no rates; using fallback shipping charge',
        );
        return this.getFallbackRate('No shipping rates available');
      }


      const delhiveryOption = rates.find((r: any) =>
        r.name?.toLowerCase().includes('delhivery'),
      );

      let selected;

      if (delhiveryOption) {
        selected = delhiveryOption;
      } else {

        selected = rates.reduce((min: any, curr: any) =>
          curr.total_charges < min.total_charges ? curr : min,
        );
      }


      return {
        success: true,
        shippingCharge: Math.ceil(Number(selected.total_charges) || 0),
        courier: selected.name,
        estimatedDelivery: selected.estimated_delivery,
        fullResponse: selected,
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const err = error as AxiosError;
        const hasApiResponse = Boolean(err.response);

        if (!hasApiResponse) {
          this.logger.warn(
            `Shipping API unavailable; using fallback shipping charge (${err.message})`,
          );

          return this.getFallbackRate(err.message);
        }

        this.logger.error('Shipping API failed', {
          data: err.response?.data,
          status: err.response?.status,
        });

        throw new HttpException(
          {
            success: false,
            message: 'Shipping rate calculation failed',
            error: err.response?.data || err.message,
          },
          err.response?.status || 500,
        );
      }

      this.logger.warn('Shipping rate unavailable; using fallback shipping charge');

      return this.getFallbackRate(
        error instanceof Error ? error.message : 'Unexpected error occurred',
      );
    }
  }

  private getFallbackRate(reason: string) {
    return {
      success: true,
      fallback: true,
      shippingCharge: this.fallbackShippingCharge,
      courier: 'Fallback shipping',
      estimatedDelivery: null,
      fullResponse: null,
      warning: reason,
    };
  }
}
