import prisma from '../db/prisma';

export async function seedLocations() {
  const existing = await prisma.location.findFirst({ where: { name: 'Bishops House' } });
  if (existing) return;

  await prisma.location.create({
    data: {
      name:     'Bishops House',
      address:  '45 Bishops Road, Hayes',
      postcode: 'UB3 2TE',
    },
  });
  console.log('[ENVICO] Seeded: Bishops House location');
}
