// ─── Types ───

export interface MilestoneData {
  slug: string;
  title: string;
  status: string;
  order: number;
  vision?: string;
  description?: string;
  successCriteria?: string[];
  dependsOn?: string[];
  keyRisks?: Array<{ risk: string; whyItMatters: string }>;
  proofStrategy?: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  boundaryMapMarkdown?: string;
  verificationContract?: string;
  verificationIntegration?: string;
  verificationOperational?: string;
  verificationUat?: string;
  definitionOfDone?: string[];
  // Per-plan gate: when true, tasks in this plan cannot transition to
  // `state: 'ready'` unless they carry at least one acceptance criterion.
  // Default for new milestones is `true` (enforce specs from day one).
  // Milestones created before this field existed have no key in their YAML
  // frontmatter; `milestoneFromFile` resolves that to `false` so historical
  // plans keep working without a forced spec rewrite.
  specRequired?: boolean;
  // Optional opaque id linking this milestone to an external mission record.
  // When absent (older plans), reader returns `undefined`. When present, the
  // value is validated against `MISSION_ID_REGEX` on read — see schema.ts.
  missionId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SliceData {
  slug: string;
  milestoneSlug: string;
  title: string;
  status: string;
  order: number;
  risk?: string;
  depends?: string[];
  goal?: string;
  demo?: string;
  successCriteria?: string;
  proofLevel?: string;
  integrationClosure?: string;
  observabilityImpact?: string;
  threatSurface?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PlanTaskData {
  slug: string;
  sliceSlug: string;
  milestoneSlug: string;
  title: string;
  status: string;
  order: number;
  model?: string;
  estimate?: string;
  files?: string[];
  verify?: string;
  depends?: string[];
  inputs?: string[];
  expectedOutput?: string[];
  executionTaskId?: number;
  output?: string;
  summary?: string;
  verificationPassed?: boolean;
  verificationOutput?: string;
  failureModes?: Array<{ depFails: string; taskBehavior: string }>;
  negativeTests?: string[];
  observabilityImpact?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}
