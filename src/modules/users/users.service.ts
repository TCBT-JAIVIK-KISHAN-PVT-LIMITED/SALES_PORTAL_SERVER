/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from './schemas/user.schema';
import { CrmService } from '../../zoho/crm/crm.service';
import { AxiosError } from 'axios';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private userModel: Model<User>,
    private crmService: CrmService,
  ) { }

  // 🔹 Find by mobile
  async findByMobile(mobile: string) {
    return this.userModel.findOne({ mobile_number: mobile });
  }

  // 🔹 Find by ID
  async findById(id: string) {
    return this.userModel.findById(id);
  }

  // 🔹 Create or Get user (OTP flow)
  async findOrCreateUser(mobile: string) {
    let user = await this.findByMobile(mobile);

    if (!user) {
      user = await this.userModel.create({
        mobile_number: mobile,
      });
    }

    return user;
  }

  // 🔹 Update user
  async updateUser(id: string, data: any) {
    const cleanId = id.replace(/[^a-fA-F0-9]/g, '');

    const user = await this.userModel.findByIdAndUpdate(cleanId, data, {
      new: true,
    });

    if (!user) throw new Error('User not found');

    // CRM sync
    if (user.zoho_contact_id) {
      try {
        await this.crmService.updateContact(user.zoho_contact_id, {
          First_Name: user.name,
          Email: user.email,
          Phone: user.mobile_number,
        });
      } catch (error) {
        console.error('CRM update failed:', error);
      }
    }

    return user;
  }

  // 🔹 Add address
  async addAddress(userId: string, address: any) {
    console.log('--- SERVICE HIT ---');
    console.log('User ID:', userId);
    console.log('Address Payload:', address);

    try {
      const result = await this.userModel.findByIdAndUpdate(
        userId,
        { $push: { addresses: address } },
        { new: true, runValidators: true }
      );

      console.log('✅ DB Update Success:', result);
      return result;
    } catch (error: unknown) {
      const AxiosError = error as AxiosError;
      console.log('❌ DB ERROR:', AxiosError.message);
      console.log(error);
      throw error;
    }
  }

  // 🔹 Find addresses by user ID
  async findAddressesByUserId(userId: string) {
    const user = await this.userModel.findById(userId);
    return user?.addresses || [];
  }

  // 🔹 Find specific address by ID
  async findAddressById(userId: string, addressId: string) {
    const user = await this.userModel.findById(userId);
    return user?.addresses.find((addr: any) => addr._id.toString() === addressId) || null;
  }

  // 🔹 Delete address
  async deleteAddress(userId: string, addressId: string) {
    console.log('--- DELETE ADDRESS ---');
    console.log('User ID:', userId);
    console.log('Address ID:', addressId);

    try {
      const updatedUser = await this.userModel.findByIdAndUpdate(
        userId,
        {
          $pull: {
            addresses: { _id: addressId },
          },
        },
        { new: true }
      );

      if (!updatedUser) {
        throw new Error('User not found');
      }

      console.log('✅ Address removed');
      return updatedUser.addresses;
    } catch (error: any) {
      console.log('❌ DELETE ERROR:', error.message);
      throw error;
    }
  }
}
