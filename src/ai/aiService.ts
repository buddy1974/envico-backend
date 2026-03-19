export interface ReferralInput {
  support_needs: string;
  urgency_level: string;
  referral_source: string;
}

export interface ReferralAnalysis {
  priority_score: number;
  risk_flags: string[];
  suggested_tasks: string[];
}

const URGENCY_BASE: Record<string, number> = {
  URGENT: 9,
  HIGH: 7,
  MEDIUM: 5,
  LOW: 3,
};

const KEYWORD_RULES: Array<{ keyword: string; risk_flag: string; task: string; score_bonus: number }> = [
  { keyword: 'medical',   risk_flag: 'MEDICAL',         task: 'Medical review',            score_bonus: 2 },
  { keyword: 'mental',    risk_flag: 'MENTAL_HEALTH',   task: 'Mental health assessment',  score_bonus: 2 },
  { keyword: 'housing',   risk_flag: 'HOUSING',         task: 'Housing assessment',        score_bonus: 1 },
  { keyword: 'financial', risk_flag: 'FINANCIAL',       task: 'Financial needs assessment',score_bonus: 1 },
  { keyword: 'dementia',  risk_flag: 'DEMENTIA',        task: 'Dementia care plan',        score_bonus: 2 },
  { keyword: 'abuse',     risk_flag: 'SAFEGUARDING',    task: 'Safeguarding referral',     score_bonus: 3 },
  { keyword: 'self-harm', risk_flag: 'SAFEGUARDING',    task: 'Safeguarding referral',     score_bonus: 3 },
  { keyword: 'carer',     risk_flag: 'CARER_SUPPORT',   task: 'Carer support assessment',  score_bonus: 1 },
  { keyword: 'substance', risk_flag: 'SUBSTANCE_USE',   task: 'Substance use assessment',  score_bonus: 2 },
  { keyword: 'mobility',  risk_flag: 'MOBILITY',        task: 'Mobility and equipment review', score_bonus: 1 },
];

export function analyzeReferral(input: ReferralInput): ReferralAnalysis {
  const needs = input.support_needs.toLowerCase();
  const urgency = input.urgency_level.toUpperCase();

  let priority_score = URGENCY_BASE[urgency] ?? 5;
  const risk_flags: string[] = [];
  const suggested_tasks: string[] = [`Review referral — initial assessment`];

  for (const rule of KEYWORD_RULES) {
    if (needs.includes(rule.keyword)) {
      if (!risk_flags.includes(rule.risk_flag)) {
        risk_flags.push(rule.risk_flag);
      }
      if (!suggested_tasks.includes(rule.task)) {
        suggested_tasks.push(rule.task);
        priority_score = Math.min(10, priority_score + rule.score_bonus);
      }
    }
  }

  // Hospital source → higher urgency
  if (input.referral_source.toLowerCase().includes('hospital')) {
    priority_score = Math.min(10, priority_score + 1);
  }

  return { priority_score, risk_flags, suggested_tasks };
}

export function scoreUrgency(input: ReferralInput): 'HIGH' | 'MEDIUM' | 'LOW' {
  const { priority_score } = analyzeReferral(input);
  if (priority_score >= 8) return 'HIGH';
  if (priority_score >= 5) return 'MEDIUM';
  return 'LOW';
}
