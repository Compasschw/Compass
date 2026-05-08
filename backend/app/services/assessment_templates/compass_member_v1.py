"""Compass Member Health & Wellness Questionnaire — template v1.

Source: Compass CHW Health & Wellness Questionnaire PDF (founder-vetted).

Ordering (per founder direction)
---------------------------------
Part 1 — Social Determinants of Health (16 questions, sections 1-6)
Part 2 — Medical & Health (23 questions, sections 7-17)

Each question carries:
  id           — stable programmatic key (never changes, used for DB lookups)
  text         — the question the CHW reads aloud / displays to the member
  section      — parent section object reference (for grouping in the UI)
  category     — "sdoh" | "medical"
  subcategory  — finer-grained domain label
  tags         — list of source-PDF classification tags
  options      — list of {value, label} dicts for single-select questions
                 Empty list means the question captures free text (future).

Source PDF question numbers are preserved as comments next to each question
for cross-reference with the founders' original document.
"""

from typing import Any

# ---------------------------------------------------------------------------
# Section definitions (ordered — UI renders them in this order)
# ---------------------------------------------------------------------------

_SECTIONS: list[dict[str, Any]] = [
    # ── Part 1: SDOH ──────────────────────────────────────────────────────
    {
        "id": "housing_economic",
        "title": "Housing & Economic Stability",
        "part": 1,
        "part_label": "Social Determinants of Health",
        "category": "sdoh",
    },
    {
        "id": "food_access",
        "title": "Food Access & Nutrition",
        "part": 1,
        "part_label": "Social Determinants of Health",
        "category": "sdoh",
    },
    {
        "id": "transportation",
        "title": "Transportation",
        "part": 1,
        "part_label": "Social Determinants of Health",
        "category": "sdoh",
    },
    {
        "id": "social_support_safety",
        "title": "Social Support & Safety",
        "part": 1,
        "part_label": "Social Determinants of Health",
        "category": "sdoh",
    },
    {
        "id": "legal_support",
        "title": "Legal Support",
        "part": 1,
        "part_label": "Social Determinants of Health",
        "category": "sdoh",
    },
    {
        "id": "wellness_physical_activity",
        "title": "Wellness & Physical Activity",
        "part": 1,
        "part_label": "Social Determinants of Health",
        "category": "sdoh",
    },
    # ── Part 2: Medical & Health ───────────────────────────────────────────
    {
        "id": "pregnancy",
        "title": "Pregnancy",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "blood_pressure",
        "title": "Blood Pressure",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "diabetes",
        "title": "Diabetes",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "heart_disease",
        "title": "Heart Disease",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "cholesterol",
        "title": "Cholesterol",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "medications",
        "title": "Medications",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "er_visits",
        "title": "ER Visits",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "mental_health",
        "title": "Mental Health",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "drug_alcohol",
        "title": "Drug / Alcohol Use",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "rehab_recovery",
        "title": "Rehab & Recovery",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
    {
        "id": "healthcare_access",
        "title": "Healthcare Access & Preventive Care",
        "part": 2,
        "part_label": "Medical & Health",
        "category": "medical",
    },
]

# ---------------------------------------------------------------------------
# Yes/No option shorthand — most questions share this shape
# ---------------------------------------------------------------------------

_YES_NO = [
    {"value": "yes", "label": "Yes"},
    {"value": "no", "label": "No"},
]

_YES_NO_UNSURE = [
    {"value": "yes", "label": "Yes"},
    {"value": "no", "label": "No"},
    {"value": "unsure", "label": "Not sure"},
]

# ---------------------------------------------------------------------------
# Questions — ordered per founder direction (SDOH first, medical second)
# Source PDF Q-numbers annotated as comments.
# ---------------------------------------------------------------------------

_QUESTIONS: list[dict[str, Any]] = [
    # ════════════════════════════════════════════════════════════════════════
    # PART 1 — SOCIAL DETERMINANTS OF HEALTH
    # ════════════════════════════════════════════════════════════════════════

    # ── Section 1: Housing & Economic Stability (source Q21, Q22, Q23) ──────
    {
        "id": "housing_situation",
        "section_id": "housing_economic",
        "source_q_num": 21,
        "text": "What best describes your current housing situation?",
        "category": "sdoh",
        "subcategory": "housing",
        "tags": ["SDOH"],
        "options": [
            {"value": "own_or_rent_stable", "label": "I own or rent a stable home"},
            {"value": "staying_with_family_friends", "label": "I am staying with family or friends temporarily"},
            {"value": "shelter_or_transitional", "label": "I am in a shelter or transitional housing"},
            {"value": "experiencing_homelessness", "label": "I am experiencing homelessness"},
            {"value": "other", "label": "Other"},
        ],
    },
    {
        "id": "housing_concern",
        "section_id": "housing_economic",
        "source_q_num": 22,
        "text": "In the past 12 months, have you been worried about losing your housing or been unable to pay rent or mortgage?",
        "category": "sdoh",
        "subcategory": "housing",
        "tags": ["SDOH"],
        "options": _YES_NO,
    },
    {
        "id": "financial_strain",
        "section_id": "housing_economic",
        "source_q_num": 23,
        "text": "In the past 12 months, have you had difficulty paying for basic needs such as food, utilities, or medication?",
        "category": "sdoh",
        "subcategory": "economic_stability",
        "tags": ["SDOH", "Member needs"],
        "options": _YES_NO,
    },

    # ── Section 2: Food Access & Nutrition (source Q24, Q25) ────────────────
    {
        "id": "food_insecurity",
        "section_id": "food_access",
        "source_q_num": 24,
        "text": "In the past 12 months, were you ever worried that food would run out before you had money to buy more?",
        "category": "sdoh",
        "subcategory": "food_access",
        "tags": ["SDOH"],
        "options": _YES_NO,
    },
    {
        "id": "healthy_food_access",
        "section_id": "food_access",
        "source_q_num": 25,
        "text": "Do you have difficulty accessing healthy food (e.g., fresh fruits and vegetables) in your neighborhood?",
        "category": "sdoh",
        "subcategory": "food_access",
        "tags": ["SDOH", "Member needs"],
        "options": _YES_NO,
    },

    # ── Section 3: Transportation (source Q26, Q27) ──────────────────────────
    {
        "id": "transportation_barrier",
        "section_id": "transportation",
        "source_q_num": 26,
        "text": "In the past 12 months, has a lack of transportation kept you from medical appointments, getting medications, or other health needs?",
        "category": "sdoh",
        "subcategory": "transportation",
        "tags": ["SDOH"],
        "options": _YES_NO,
    },
    {
        "id": "transportation_reliability",
        "section_id": "transportation",
        "source_q_num": 27,
        "text": "Do you have reliable transportation to get to your appointments?",
        "category": "sdoh",
        "subcategory": "transportation",
        "tags": ["SDOH", "Member needs"],
        "options": _YES_NO,
    },

    # ── Section 4: Social Support & Safety (source Q28, Q29) ────────────────
    {
        "id": "social_isolation",
        "section_id": "social_support_safety",
        "source_q_num": 28,
        "text": "How often do you feel isolated or lack social support from family, friends, or community?",
        "category": "sdoh",
        "subcategory": "social_support",
        "tags": ["SDOH"],
        "options": [
            {"value": "never", "label": "Never"},
            {"value": "rarely", "label": "Rarely"},
            {"value": "sometimes", "label": "Sometimes"},
            {"value": "often", "label": "Often"},
            {"value": "always", "label": "Always"},
        ],
    },
    {
        "id": "safety_at_home",
        "section_id": "social_support_safety",
        "source_q_num": 29,
        "text": "Do you feel safe where you currently live?",
        "category": "sdoh",
        "subcategory": "safety",
        "tags": ["SDOH", "Member needs"],
        "options": _YES_NO,
    },

    # ── Section 5: Legal Support (source Q30, Q31, Q32) ─────────────────────
    {
        "id": "legal_needs",
        "section_id": "legal_support",
        "source_q_num": 30,
        "text": "Do you currently have any legal concerns (such as immigration status, landlord disputes, debt collection, or benefits appeals)?",
        "category": "sdoh",
        "subcategory": "legal",
        "tags": ["SDOH", "Member needs"],
        "options": _YES_NO,
    },
    {
        "id": "legal_help_desired",
        "section_id": "legal_support",
        "source_q_num": 31,
        "text": "Would you like help connecting with legal aid services?",
        "category": "sdoh",
        "subcategory": "legal",
        "tags": ["SDOH", "Member needs"],
        "options": _YES_NO,
    },
    {
        "id": "immigration_barrier",
        "section_id": "legal_support",
        "source_q_num": 32,
        "text": "Have concerns about immigration status ever prevented you or a family member from seeking healthcare?",
        "category": "sdoh",
        "subcategory": "legal",
        "tags": ["SDOH"],
        "options": _YES_NO,
    },

    # ── Section 6: Wellness & Physical Activity (source Q36, Q37, Q38, Q39) ─
    {
        "id": "physical_activity_frequency",
        "section_id": "wellness_physical_activity",
        "source_q_num": 36,
        "text": "How many days per week do you engage in moderate physical activity for at least 30 minutes (e.g., walking, swimming, cycling)?",
        "category": "sdoh",
        "subcategory": "wellness",
        "tags": ["SDOH", "Member needs"],
        "options": [
            {"value": "0", "label": "0 days"},
            {"value": "1_2", "label": "1–2 days"},
            {"value": "3_4", "label": "3–4 days"},
            {"value": "5_plus", "label": "5 or more days"},
        ],
    },
    {
        "id": "physical_activity_barrier",
        "section_id": "wellness_physical_activity",
        "source_q_num": 37,
        "text": "Are there barriers that prevent you from being physically active (e.g., pain, cost, safety, lack of time)?",
        "category": "sdoh",
        "subcategory": "wellness",
        "tags": ["SDOH", "Member needs"],
        "options": _YES_NO,
    },
    {
        "id": "stress_level",
        "section_id": "wellness_physical_activity",
        "source_q_num": 38,
        "text": "How would you rate your current stress level?",
        "category": "sdoh",
        "subcategory": "wellness",
        "tags": ["SDOH"],
        "options": [
            {"value": "low", "label": "Low — manageable most days"},
            {"value": "moderate", "label": "Moderate — noticeable but coping"},
            {"value": "high", "label": "High — struggling to cope"},
            {"value": "very_high", "label": "Very high — overwhelmed"},
        ],
    },
    {
        "id": "sleep_quality",
        "section_id": "wellness_physical_activity",
        "source_q_num": 39,
        "text": "How would you describe your sleep quality over the past two weeks?",
        "category": "sdoh",
        "subcategory": "wellness",
        "tags": ["SDOH"],
        "options": [
            {"value": "good", "label": "Good — 7–9 hours, feel rested"},
            {"value": "fair", "label": "Fair — some difficulty falling or staying asleep"},
            {"value": "poor", "label": "Poor — consistently poor sleep, feel tired"},
        ],
    },

    # ════════════════════════════════════════════════════════════════════════
    # PART 2 — MEDICAL & HEALTH
    # ════════════════════════════════════════════════════════════════════════

    # ── Section 7: Pregnancy (source Q1) ────────────────────────────────────
    {
        "id": "pregnancy_status",
        "section_id": "pregnancy",
        "source_q_num": 1,
        "text": "Are you currently pregnant or have you been pregnant in the past 12 months?",
        "category": "medical",
        "subcategory": "pregnancy",
        "tags": ["HEDIS"],
        "options": [
            {"value": "currently_pregnant", "label": "Yes, currently pregnant"},
            {"value": "pregnant_past_year", "label": "Yes, pregnant in the past 12 months"},
            {"value": "no", "label": "No"},
            {"value": "prefer_not_to_say", "label": "Prefer not to say"},
        ],
    },

    # ── Section 8: Blood Pressure (source Q2, Q3, Q4, Q5) ──────────────────
    {
        "id": "hypertension_diagnosis",
        "section_id": "blood_pressure",
        "source_q_num": 2,
        "text": "Have you ever been told by a doctor or health professional that you have high blood pressure (hypertension)?",
        "category": "medical",
        "subcategory": "blood_pressure",
        "tags": ["HEDIS"],
        "options": _YES_NO_UNSURE,
    },
    {
        "id": "hypertension_medication",
        "section_id": "blood_pressure",
        "source_q_num": 3,
        "text": "If yes, are you currently taking medication for high blood pressure?",
        "category": "medical",
        "subcategory": "blood_pressure",
        "tags": ["HEDIS"],
        "options": [
            {"value": "yes", "label": "Yes, taking medication"},
            {"value": "no_has_diagnosis", "label": "No, but I have a diagnosis"},
            {"value": "not_applicable", "label": "Not applicable"},
        ],
    },
    {
        "id": "blood_pressure_monitoring",
        "section_id": "blood_pressure",
        "source_q_num": 4,
        "text": "How often do you check your blood pressure?",
        "category": "medical",
        "subcategory": "blood_pressure",
        "tags": ["HEDIS", "Member needs"],
        "options": [
            {"value": "daily", "label": "Daily"},
            {"value": "weekly", "label": "Weekly"},
            {"value": "monthly", "label": "Monthly or less"},
            {"value": "never", "label": "Never"},
            {"value": "not_applicable", "label": "Not applicable (no diagnosis)"},
        ],
    },
    {
        "id": "blood_pressure_controlled",
        "section_id": "blood_pressure",
        "source_q_num": 5,
        "text": "Do you feel your blood pressure is well controlled?",
        "category": "medical",
        "subcategory": "blood_pressure",
        "tags": ["HEDIS"],
        "options": _YES_NO_UNSURE,
    },

    # ── Section 9: Diabetes (source Q6) ─────────────────────────────────────
    {
        "id": "diabetes_diagnosis",
        "section_id": "diabetes",
        "source_q_num": 6,
        "text": "Have you ever been told by a doctor or health professional that you have diabetes or pre-diabetes?",
        "category": "medical",
        "subcategory": "diabetes",
        "tags": ["HEDIS"],
        "options": [
            {"value": "diabetes", "label": "Yes, diabetes"},
            {"value": "prediabetes", "label": "Yes, pre-diabetes"},
            {"value": "no", "label": "No"},
            {"value": "unsure", "label": "Not sure"},
        ],
    },

    # ── Section 10: Heart Disease (source Q7) ────────────────────────────────
    {
        "id": "heart_disease_diagnosis",
        "section_id": "heart_disease",
        "source_q_num": 7,
        "text": "Have you ever been diagnosed with heart disease, heart attack, or congestive heart failure?",
        "category": "medical",
        "subcategory": "heart_disease",
        "tags": ["HEDIS"],
        "options": _YES_NO_UNSURE,
    },

    # ── Section 11: Cholesterol (source Q8) ──────────────────────────────────
    {
        "id": "high_cholesterol_diagnosis",
        "section_id": "cholesterol",
        "source_q_num": 8,
        "text": "Have you ever been told by a doctor or health professional that you have high cholesterol?",
        "category": "medical",
        "subcategory": "cholesterol",
        "tags": ["HEDIS"],
        "options": _YES_NO_UNSURE,
    },

    # ── Section 12: Medications (source Q9, Q10) ─────────────────────────────
    {
        "id": "medication_adherence",
        "section_id": "medications",
        "source_q_num": 9,
        "text": "Are you currently taking any prescription medications on a regular basis?",
        "category": "medical",
        "subcategory": "medications",
        "tags": ["HEDIS", "Member needs"],
        "options": _YES_NO,
    },
    {
        "id": "medication_affordability",
        "section_id": "medications",
        "source_q_num": 10,
        "text": "In the past 12 months, have you ever skipped doses or stopped taking medication because of the cost?",
        "category": "medical",
        "subcategory": "medications",
        "tags": ["HEDIS", "Member needs"],
        "options": _YES_NO,
    },

    # ── Section 13: ER Visits (source Q11, Q12) ──────────────────────────────
    {
        "id": "er_visit_past_year",
        "section_id": "er_visits",
        "source_q_num": 11,
        "text": "In the past 12 months, have you visited an emergency room (ER) for a health concern?",
        "category": "medical",
        "subcategory": "er_visits",
        "tags": ["HEDIS"],
        "options": _YES_NO,
    },
    {
        "id": "er_visit_frequency",
        "section_id": "er_visits",
        "source_q_num": 12,
        "text": "If yes, how many times did you visit the ER in the past 12 months?",
        "category": "medical",
        "subcategory": "er_visits",
        "tags": ["HEDIS", "Member needs"],
        "options": [
            {"value": "once", "label": "Once"},
            {"value": "twice", "label": "Twice"},
            {"value": "3_or_more", "label": "3 or more times"},
            {"value": "not_applicable", "label": "Not applicable (no ER visit)"},
        ],
    },

    # ── Section 14: Mental Health (source Q13, Q14, Q15, Q16) ───────────────
    {
        "id": "depression_anxiety_diagnosis",
        "section_id": "mental_health",
        "source_q_num": 13,
        "text": "Have you ever been diagnosed with depression, anxiety, or another mental health condition?",
        "category": "medical",
        "subcategory": "mental_health",
        "tags": ["HEDIS"],
        "options": _YES_NO_UNSURE,
    },
    {
        "id": "mental_health_treatment",
        "section_id": "mental_health",
        "source_q_num": 14,
        "text": "Are you currently receiving treatment or support for a mental health condition (e.g., therapy, medication, counseling)?",
        "category": "medical",
        "subcategory": "mental_health",
        "tags": ["HEDIS", "Member needs"],
        "options": _YES_NO,
    },
    {
        "id": "phq2_little_interest",
        "section_id": "mental_health",
        "source_q_num": 15,
        "text": "Over the past two weeks, how often have you had little interest or pleasure in doing things? (PHQ-2 screen)",
        "category": "medical",
        "subcategory": "mental_health",
        "tags": ["HEDIS"],
        "options": [
            {"value": "not_at_all", "label": "Not at all"},
            {"value": "several_days", "label": "Several days"},
            {"value": "more_than_half", "label": "More than half the days"},
            {"value": "nearly_every_day", "label": "Nearly every day"},
        ],
    },
    {
        "id": "phq2_feeling_down",
        "section_id": "mental_health",
        "source_q_num": 16,
        "text": "Over the past two weeks, how often have you felt down, depressed, or hopeless? (PHQ-2 screen)",
        "category": "medical",
        "subcategory": "mental_health",
        "tags": ["HEDIS"],
        "options": [
            {"value": "not_at_all", "label": "Not at all"},
            {"value": "several_days", "label": "Several days"},
            {"value": "more_than_half", "label": "More than half the days"},
            {"value": "nearly_every_day", "label": "Nearly every day"},
        ],
    },

    # ── Section 15: Drug / Alcohol Use (source Q17, Q18) ────────────────────
    {
        "id": "alcohol_use",
        "section_id": "drug_alcohol",
        "source_q_num": 17,
        "text": "How often do you have a drink containing alcohol?",
        "category": "medical",
        "subcategory": "drug_alcohol",
        "tags": ["HEDIS"],
        "options": [
            {"value": "never", "label": "Never"},
            {"value": "monthly_or_less", "label": "Monthly or less"},
            {"value": "2_4_per_month", "label": "2–4 times per month"},
            {"value": "2_3_per_week", "label": "2–3 times per week"},
            {"value": "4_or_more_per_week", "label": "4 or more times per week"},
        ],
    },
    {
        "id": "substance_use",
        "section_id": "drug_alcohol",
        "source_q_num": 18,
        "text": "In the past 12 months, have you used any recreational drugs or substances not prescribed by a doctor?",
        "category": "medical",
        "subcategory": "drug_alcohol",
        "tags": ["HEDIS", "Member needs"],
        "options": _YES_NO,
    },

    # ── Section 16: Rehab & Recovery (source Q19, Q20) ───────────────────────
    {
        "id": "recovery_program",
        "section_id": "rehab_recovery",
        "source_q_num": 19,
        "text": "Are you currently participating in or recently completed a rehabilitation or recovery program (e.g., substance use, physical, mental health)?",
        "category": "medical",
        "subcategory": "rehab_recovery",
        "tags": ["Member needs"],
        "options": _YES_NO,
    },
    {
        "id": "recovery_support_needed",
        "section_id": "rehab_recovery",
        "source_q_num": 20,
        "text": "Would you like help finding recovery or rehabilitation support services?",
        "category": "medical",
        "subcategory": "rehab_recovery",
        "tags": ["Member needs"],
        "options": _YES_NO,
    },

    # ── Section 17: Healthcare Access & Preventive Care (source Q33, Q34, Q35)
    {
        "id": "primary_care_provider",
        "section_id": "healthcare_access",
        "source_q_num": 33,
        "text": "Do you have a primary care provider or doctor you see regularly?",
        "category": "medical",
        "subcategory": "healthcare_access",
        "tags": ["HEDIS", "SDOH"],
        "options": _YES_NO,
    },
    {
        "id": "last_checkup",
        "section_id": "healthcare_access",
        "source_q_num": 34,
        "text": "When was your last routine health checkup or physical exam?",
        "category": "medical",
        "subcategory": "healthcare_access",
        "tags": ["HEDIS"],
        "options": [
            {"value": "within_year", "label": "Within the past year"},
            {"value": "1_2_years", "label": "1–2 years ago"},
            {"value": "more_than_2_years", "label": "More than 2 years ago"},
            {"value": "never", "label": "Never"},
        ],
    },
    {
        "id": "preventive_screenings_current",
        "section_id": "healthcare_access",
        "source_q_num": 35,
        "text": "Are you up to date with recommended preventive screenings (e.g., mammogram, colonoscopy, cervical cancer screening, vaccinations)?",
        "category": "medical",
        "subcategory": "healthcare_access",
        "tags": ["HEDIS"],
        "options": _YES_NO_UNSURE,
    },
]

# ---------------------------------------------------------------------------
# Validation at import time — ensures referential integrity within the template
# ---------------------------------------------------------------------------

_section_ids = {s["id"] for s in _SECTIONS}
for _q in _QUESTIONS:
    assert _q["section_id"] in _section_ids, (
        f"Question {_q['id']!r} references unknown section {_q['section_id']!r}"
    )

# Verify counts match the spec (16 SDOH + 23 medical = 39 total)
_sdoh_count = sum(1 for q in _QUESTIONS if q["category"] == "sdoh")
_medical_count = sum(1 for q in _QUESTIONS if q["category"] == "medical")
assert _sdoh_count == 16, f"Expected 16 SDOH questions, got {_sdoh_count}"
assert _medical_count == 23, f"Expected 23 medical questions, got {_medical_count}"
assert len(_QUESTIONS) == 39, f"Expected 39 total questions, got {len(_QUESTIONS)}"

# ---------------------------------------------------------------------------
# Public template dict — JSON-serializable
# ---------------------------------------------------------------------------

TEMPLATE: dict[str, Any] = {
    "id": "compass_member_v1",
    "name": "Compass Member Health & Wellness Questionnaire",
    "version": "1.0",
    "description": (
        "39-question health and wellness screener for Compass CHW members. "
        "Part 1 covers Social Determinants of Health (16 questions); "
        "Part 2 covers Medical & Health history (23 questions). "
        "Tagged with HEDIS, SDOH, and Member needs classifications for "
        "AI summary and admin reporting filters."
    ),
    "total_questions": 39,
    "sections": _SECTIONS,
    "questions": _QUESTIONS,
    "metadata": {
        "sdoh_count": _sdoh_count,
        "medical_count": _medical_count,
        "hedis_tagged_count": sum(1 for q in _QUESTIONS if "HEDIS" in q["tags"]),
        "sdoh_tagged_count": sum(1 for q in _QUESTIONS if "SDOH" in q["tags"]),
        "member_needs_tagged_count": sum(1 for q in _QUESTIONS if "Member needs" in q["tags"]),
    },
}
