import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../db/prisma';

export async function registerUser(name: string, email: string, password: string, role: string, location_id?: number) {
  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, password: hashed, role, ...(location_id ? { location_id } : {}) },
    select: { id: true, name: true, email: true, role: true, is_active: true, created_at: true },
  });
  return user;
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return { error: 'INVALID_CREDENTIALS' as const };
  if (!user.is_active) return { error: 'ACCOUNT_DISABLED' as const };

  const match = await bcrypt.compare(password, user.password);
  if (!match) return { error: 'INVALID_CREDENTIALS' as const };

  const secret = process.env.JWT_SECRET!;
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    secret,
    { expiresIn: '8h' }
  );

  const refreshToken = crypto.randomBytes(40).toString('hex');
  await prisma.user.update({
    where: { id: user.id },
    data: { refresh_token: refreshToken, last_login: new Date() },
  });

  return {
    token: accessToken,
    refresh_token: refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const user = await prisma.user.findUnique({ where: { refresh_token: refreshToken } });
  if (!user || !user.is_active) return { error: 'INVALID_REFRESH_TOKEN' as const };

  const secret = process.env.JWT_SECRET!;
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    secret,
    { expiresIn: '8h' }
  );

  return {
    token: accessToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

export async function logoutUser(refreshToken: string) {
  await prisma.user.updateMany({
    where: { refresh_token: refreshToken },
    data: { refresh_token: null },
  });
}
