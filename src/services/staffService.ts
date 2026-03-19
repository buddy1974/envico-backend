import prisma from '../db/prisma';

export interface CreateStaffInput {
  name: string;
  role: string;
  email: string;
  phone: string;
}

export async function createStaff(input: CreateStaffInput) {
  return prisma.staff.create({ data: input });
}

export async function getStaffById(id: number) {
  return prisma.staff.findUnique({ where: { id } });
}

export async function listStaff() {
  return prisma.staff.findMany({ orderBy: { created_at: 'asc' } });
}
