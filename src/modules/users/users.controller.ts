import { Controller, Get, Patch, Body, Param, Delete } from '@nestjs/common';
import { UsersService } from './users.service';
import { AddAddressDto } from './dto/add-address.dto';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) { }

  @Get(':id')
  getUser(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Patch(':id')
  updateUser(@Param('id') id: string, @Body() body: any) {
    return this.usersService.updateUser(id, body);
  }


  @Patch(':id/address')
  addAddress(
    @Param('id') id: string,
    @Body() body: AddAddressDto,
  ) {
    return this.usersService.addAddress(id, body);
  }

  @Get(':id/address')
  getUserAddresses(@Param('id') id: string) {
    return this.usersService.findAddressesByUserId(id);
  }

  @Get(':id/address/:addressId')
  getUserAddress(@Param('id') id: string, @Param('addressId') addressId: string) {
    return this.usersService.findAddressById(id, addressId);
  }

  @Delete(':id/address/:addressId')
  deleteUserAddress(
    @Param('id') id: string,
    @Param('addressId') addressId: string,
  ) {
    return this.usersService.deleteAddress(id, addressId);
  }
}
