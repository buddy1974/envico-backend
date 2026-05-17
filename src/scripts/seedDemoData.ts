/**
 * seedDemoData.ts
 * Seeds a demo family account + a demo service user with full care data.
 * Safe to call on every startup — skips if already exists.
 *
 * Demo credentials:
 *   family.demo@envicosl.co.uk / london2026  (FAMILY role)
 *   Linked to demo service user: James Wilson
 */
import bcrypt from 'bcrypt';
import prisma from '../db/prisma';

export async function seedDemoData(): Promise<void> {
  try {
    // 1. Demo service user
    let serviceUser = await prisma.serviceUser.findFirst({
      where: { first_name: 'James', last_name: 'Wilson (Demo)' },
    });

    if (!serviceUser) {
      serviceUser = await prisma.serviceUser.create({
        data: {
          first_name:       'James',
          last_name:        'Wilson (Demo)',
          dob:              new Date('1978-04-12'),
          gender:           'Male',
          care_type:        'SUPPORTED_LIVING',
          status:           'ACTIVE',
          nhs_number:       'NHS-DEMO-001',
          address_line1:    '59 Commonwealth Avenue',
          city:             'Hayes',
          postcode:         'UB3 2PN',
          primary_language: 'English',
          gp_name:          'Dr. Sarah Patel',
          gp_practice:      'Hayes Medical Centre',
          nok_name:         'Margaret Wilson',
          nok_relationship: 'Sister',
          nok_phone:        '07700900001',
        },
      });
      console.log('[seedDemo] Created demo service user: James Wilson');

      // 2. Active care plan
      await prisma.carePlan.create({
        data: {
          service_user_id: serviceUser.id,
          title:           'Community Integration & Independence Plan',
          description:     'Supporting James to develop daily living skills, build social connections and maintain his wellbeing in a supported living environment.',
          goals:           [
            'Develop independent cooking skills — preparing 3 meals per week',
            'Attend community social group every Thursday',
            'Manage personal budget with weekly check-ins',
            'Maintain regular contact with family members',
          ],
          status:          'ACTIVE',
          review_date:     new Date('2026-09-01'),
          created_by:      'Envico Care Team',
          version:         2,
        },
      });
      console.log('[seedDemo] Created demo care plan');

      // 3. Active medications
      await prisma.medication.createMany({
        data: [
          {
            service_user_id: serviceUser.id,
            name:            'Sertraline',
            dosage:          '50mg',
            frequency:       'Once daily — morning',
            route:           'Oral',
            prescribed_by:   'Dr. Sarah Patel',
            start_date:      new Date('2025-06-01'),
            status:          'ACTIVE',
            notes:           'Take with food. Monitor for mood changes.',
          },
          {
            service_user_id: serviceUser.id,
            name:            'Loratadine',
            dosage:          '10mg',
            frequency:       'Once daily as needed',
            route:           'Oral',
            prescribed_by:   'Dr. Sarah Patel',
            start_date:      new Date('2025-09-01'),
            status:          'ACTIVE',
            notes:           'Seasonal antihistamine — spring/summer.',
          },
        ],
      });
      console.log('[seedDemo] Created demo medications');

      // 4. Recent incidents (low severity only for family view)
      await prisma.incident.create({
        data: {
          service_user_id: serviceUser.id,
          type:            'ACCIDENT',
          severity:        'LOW',
          description:     'James slipped on wet floor in kitchen. No injury sustained. Floor was dried and anti-slip mat added.',
          reported_by:     'Key Worker — Lisa Ahmed',
          action_taken:    'First aid assessment completed. No treatment required. Hazard removed.',
          status:          'CLOSED',
          reported_at:     new Date('2026-05-10T14:30:00Z'),
        },
      });
      console.log('[seedDemo] Created demo incident');

      // 5. Activity logs (care updates)
      await prisma.activityLog.createMany({
        data: [
          {
            entity:    'SERVICE_USER',
            entity_id: serviceUser.id,
            action:    'CARE_UPDATE',
            details:   'James attended Thursday social group at Hayes Community Centre. Engaged well with peers and participated in art session.',
          },
          {
            entity:    'SERVICE_USER',
            entity_id: serviceUser.id,
            action:    'MEDICATION_ADMINISTERED',
            details:   'Morning medications administered as prescribed. James in good spirits.',
          },
          {
            entity:    'SERVICE_USER',
            entity_id: serviceUser.id,
            action:    'CARE_UPDATE',
            details:   'James successfully prepared lunch independently today — pasta with vegetables. Excellent progress toward independence goals.',
          },
        ],
      });
      console.log('[seedDemo] Created demo activity logs');
    }

    // 6. Demo FAMILY user — linked to demo service user
    const demoEmail = 'family.demo@envicosl.co.uk';
    const existingFamily = await prisma.user.findUnique({ where: { email: demoEmail } });

    if (!existingFamily) {
      const hashed = await bcrypt.hash('london2026', 10);
      await prisma.user.create({
        data: {
          name:                   'Margaret Wilson (Demo)',
          email:                  demoEmail,
          password:               hashed,
          role:                   'FAMILY',
          is_active:              true,
          family_service_user_id: serviceUser.id,
        },
      });
      console.log('[seedDemo] Created demo family user: family.demo@envicosl.co.uk / london2026');
    }
  } catch (err: any) {
    console.error('[seedDemo] Error:', err.message);
    // Non-fatal — server continues
  }
}
