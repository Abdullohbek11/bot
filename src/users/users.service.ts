import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { InjectModel } from "@nestjs/sequelize";
import { User } from "./models/user.model";
import * as bcrypt from "bcrypt";
import { JwtService } from "@nestjs/jwt";
import { MailService } from "../mail/mail.service";
import { PhoneUserDto } from "./dto/phone-user.dto";
import * as otpGenerator from "otp-generator";
import { BotService } from "../bot/bot.service";
import { Otp } from "../otp/models/otp.model";
import { AddMinutesToDate } from "../helpers/addMinutes";
import * as uuid from "uuid";
import { decode, encode } from "../helpers/crypto";
import { VerifyOtpDto } from "./dto/verify-otp.dto copy";

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(Otp) private otpModel: typeof Otp,
    private readonly jwtService: JwtService,
    private readonly botService: BotService
  ) {}

  async newOtp(phoneUserDto: PhoneUserDto) {
    const phone_number = phoneUserDto.phone;
    const otp = otpGenerator.generate(4, {
      upperCaseAlphabets: false,
      lowerCaseAlphabets: false,
      specialChars: false,
    });
    const isSend = await this.botService.sendOtp(phone_number, otp);
    if (!isSend) {
      throw new BadRequestException("Avval botdan ro'yxatdan o'ting!");
    }

    const now = new Date();

    const expiration_time = AddMinutesToDate(now, 5);
    await this.otpModel.destroy({ where: { phone_number } });

    const newOtp = await this.otpModel.create({
      id: uuid.v4(),
      otp,
      expiration_time,
      phone_number,
    });

    const details = {
      timestamp: now,
      phone_number,
      otp_id: newOtp.id,
    };

    const encodedData = await encode(JSON.stringify(details));

    return { message: "OTP telegramga yuborildi", details: encodedData };
  }

  async verifyOtp(verifyOtpDto: VerifyOtpDto) {
    const { verification_key, otp, phone_number } = verifyOtpDto;
    const currentDate = new Date();
    const decodedData = await decode(verification_key);
    const details = JSON.parse(decodedData);
    if (details.phone_number != phone_number) {
      throw new BadRequestException("OTP bu raqamga yuborilmagan");
    }
    const resultOtp = await this.otpModel.findOne({
      where: { id: details.otp_id },
    });
    if (!resultOtp) {
      throw new BadRequestException("Bunday OTP mavjud emas");
    }
    if (resultOtp.verified) {
      throw new BadRequestException("Bu OTP avval tekshirilgan");
    }
    if (resultOtp.expiration_time < currentDate) {
      throw new BadRequestException("Bu OTPning vaqti tugagan");
    }
    if (resultOtp.otp !== otp) {
      throw new BadRequestException("OTP mos emas");
    }
    const user = await this.userModel.update(
      {
        is_owner: true,
      },
      {
        where: { phone: phone_number },
        returning: true,
      }
    );
    if (!user[1][0]) {
      throw new BadRequestException("Bunday foydalanuvchi yo'q");
    }
    await this.otpModel.update(
      {
        verified: true,
      },
      {
        where: {id: details.otp_id},
        returning: true
      }
    );

    const response = {
      message: "Siz owner bo'ldingiz",
      owner: user[1][0].is_owner
    }

    return response;
  }

  async generateTokens(user: User) {
    const payload = {
      id: user.id,
      is_active: user.is_active,
      is_owner: user.is_owner,
    };

    const [access_token, refresh_token] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: process.env.ACCESS_TOKEN_KEY,
        expiresIn: process.env.ACCESS_TOKEN_TIME,
      }),
      this.jwtService.signAsync(payload, {
        secret: process.env.REFRESH_TOKEN_KEY,
        expiresIn: process.env.REFRESH_TOKEN_TIME,
      }),
    ]);
    return { access_token, refresh_token };
  }

  findUserByEmail(email: string) {
    return this.userModel.findOne({
      where: { email },
    });
  }

  async create(createUserDto: CreateUserDto) {
    const hashedPassword = await bcrypt.hash(createUserDto.password, 3);
    const newUser = await this.userModel.create({
      ...createUserDto,
      hashed_password: hashedPassword,
    });
    return newUser;
  }

  async activateUser(
    link: string
  ): Promise<{ is_active: boolean; message: string }> {
    const user = await this.userModel.findOne({
      where: { activation_link: link, is_active: false },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (user.is_active) {
      throw new BadRequestException("User already activated");
    }

    user.is_active = true;
    await user.save();

    return {
      is_active: user.is_active,
      message: "User activated successfully",
    };
  }

  findAll() {
    return this.userModel.findAll({ include: { all: true } });
  }

  findOne(id: number) {
    return this.userModel.findOne({ where: { id }, include: { all: true } });
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return this.userModel.update(updateUserDto, {
      where: { id },
      returning: true,
    });
  }

  remove(id: number) {
    return this.userModel.destroy({ where: { id } });
  }
}
