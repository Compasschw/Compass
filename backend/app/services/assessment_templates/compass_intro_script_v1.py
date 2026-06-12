"""Compass CHW Introduction Script — template v1.

Source: Compass CHW Introduction Script (founder-vetted PDF).

This script is displayed inline alongside the questionnaire as a collapsible
side panel. Each step contains:
  - The CHW-facing language the CHW reads or follows (verbatim from the PDF)
  - Tip boxes with colour-coded urgency levels:
      "hesitant"    → purple — if the member seems hesitant or reluctant
      "digital"     → blue   — if the member is unfamiliar with digital devices
      "policy"      → yellow — important — know your policy before acting
      "crisis"      → red    — if the member discloses a crisis situation
  - Sample transition phrases at the end of each step (where applicable)

Rendering note: the frontend should treat `script_text` as verbatim CHW
language (italicised), and `tips` as callout boxes keyed by `type`.
`phrases` is a flat list of sample transition phrases for that step.
"""

from typing import Any

TEMPLATE: dict[str, Any] = {
    "id": "compass_intro_script_v1",
    "name": "Compass CHW Introduction Script",
    "version": "1.0",
    "description": (
        "7-step introduction script for CHWs to follow at the start of a "
        "member health and wellness assessment. Covers warm opening, purpose "
        "explanation, digital format introduction, confidentiality, verbal "
        "consent, pacing guidance, and closing."
    ),
    "total_steps": 7,
    "steps": [
        # ── Step 1 ─────────────────────────────────────────────────────────
        {
            "step": 1,
            "title": "Warm Opening & Introduction",
            "script_text": (
                "Hello, my name is [Your Name] and I am a Community Health Worker "
                "with Compass CHW. Thank you so much for making time to connect with "
                "me today. How are you feeling? I want you to know that I am here to "
                "support you — not to judge you. Everything we talk about today is "
                "confidential, and my only goal is to help you get the resources and "
                "care you need."
            ),
            "tips": [
                {
                    "type": "hesitant",
                    "label": "If the member seems hesitant",
                    "text": (
                        "Take a breath and slow down. You do not need to complete the "
                        "full questionnaire in one visit. Remind the member that they "
                        "can skip any question they are not comfortable with, and that "
                        "their participation is completely voluntary."
                    ),
                },
            ],
            "phrases": [
                "I am really glad we could connect today.",
                "There is no right or wrong answer here — just share what feels comfortable.",
                "Take your time. We are not in a rush.",
            ],
        },

        # ── Step 2 ─────────────────────────────────────────────────────────
        {
            "step": 2,
            "title": "Explain the Purpose",
            "script_text": (
                "Today, I would like to go through a short health and wellness "
                "questionnaire with you. The questions cover things like your housing "
                "situation, access to food and transportation, and some health history. "
                "We use your answers to better understand what is going on in your life "
                "and to connect you with the right services. This is not a medical exam "
                "— it is a conversation so we can figure out the best ways to support you."
            ),
            "tips": [
                {
                    "type": "hesitant",
                    "label": "If the member asks why you need this information",
                    "text": (
                        "Explain: \"These questions help our team understand the full "
                        "picture of what you are dealing with so we are not guessing. "
                        "The more you share, the better we can match you to the right "
                        "programs and services.\""
                    ),
                },
            ],
            "phrases": [
                "Think of this as a check-in, not a test.",
                "We ask everyone these same questions — you are not being singled out.",
                "Your answers help us do our jobs better for you.",
            ],
        },

        # ── Step 3 ─────────────────────────────────────────────────────────
        {
            "step": 3,
            "title": "Introduce the Digital Format",
            "script_text": (
                "I will be entering your answers into our secure app as we go. "
                "You do not need to use the app yourself — I will handle that. "
                "The app saves everything right away so nothing gets lost, and it "
                "keeps your information protected with the same security standards "
                "used in healthcare. If at any point you want to see what I entered, "
                "just ask and I will show you."
            ),
            "tips": [
                {
                    "type": "digital",
                    "label": "If the member is unfamiliar with digital tools",
                    "text": (
                        "Reassure them: \"You do not need to know anything about "
                        "technology. I am the one using the app — you just talk to "
                        "me like you normally would. Think of it like a paper form "
                        "but faster and more secure.\""
                    ),
                },
            ],
            "phrases": [
                "I will handle all the tech — you just focus on talking with me.",
                "Everything is saved as we go, so we will not lose any of your answers.",
                "This is the same kind of secure system your doctor's office uses.",
            ],
        },

        # ── Step 4 ─────────────────────────────────────────────────────────
        {
            "step": 4,
            "title": "Address Confidentiality & Data Security",
            "script_text": (
                "Before we start, I want to be clear about confidentiality. "
                "What you share with me today is private. Your information is "
                "stored securely and is only accessible to the Compass CHW team "
                "that is directly supporting you. We do not share your personal "
                "health information with employers, immigration authorities, or "
                "anyone outside our care team. The only exceptions are situations "
                "where there is a serious safety concern — for example, if I believe "
                "you or someone else is in immediate danger. I am required by law to "
                "report that. Outside of those situations, everything stays between us."
            ),
            "tips": [
                {
                    "type": "policy",
                    "label": "Important — Know Your Policy",
                    "text": (
                        "Before conducting any assessment, make sure you understand "
                        "your organization's mandatory reporting obligations and any "
                        "applicable HIPAA privacy rules. Do not make promises you "
                        "cannot keep. If you are unsure whether something must be "
                        "reported, pause and consult your supervisor."
                    ),
                },
                {
                    "type": "hesitant",
                    "label": "If the member is worried about immigration or government access",
                    "text": (
                        "You can say: \"Compass CHW does not share your information "
                        "with immigration authorities or any government agency for "
                        "enforcement purposes. You are safe to share here.\""
                    ),
                },
            ],
            "phrases": [
                "Your privacy is something I take very seriously.",
                "You are always in control of what you share with me.",
                "I will tell you right away if we ever reach a topic where I have a different reporting obligation.",
            ],
        },

        # ── Step 5 ─────────────────────────────────────────────────────────
        {
            "step": 5,
            "title": "Obtain Verbal Consent",
            "script_text": (
                "Before I start the questionnaire, I need to ask for your verbal "
                "consent. Do I have your permission to ask you these health and "
                "wellness questions and to record your answers in our secure system? "
                "You can change your mind and stop at any point, and you can skip "
                "any question you are not comfortable answering. Your participation "
                "is completely voluntary."
            ),
            "tips": [
                {
                    "type": "policy",
                    "label": "Important — Verbal Consent Required",
                    "text": (
                        "Wait for the member to affirmatively say 'yes' or give clear "
                        "verbal agreement before proceeding. Do NOT continue if the "
                        "member seems confused, unsure, or under duress. If consent is "
                        "declined, thank the member, document the refusal, and do not "
                        "conduct the assessment. Your supervisor can advise on next steps."
                    ),
                },
            ],
            "phrases": [
                "Great — I appreciate your trust. Let us get started.",
                "Thank you. And remember, you can stop or skip anything at any time.",
                "I will move at whatever pace works for you.",
            ],
        },

        # ── Step 6 ─────────────────────────────────────────────────────────
        {
            "step": 6,
            "title": "During the Questionnaire",
            "script_text": (
                "As we go through the questions, I will read each one aloud and "
                "give you the answer choices. Just let me know which answer fits "
                "best — there is no right or wrong. If a question does not apply "
                "to you, just say so and we will move on. If you want to go back "
                "and change an answer, that is completely fine. We can take breaks "
                "whenever you need them. Some of the questions touch on sensitive "
                "topics like mental health, housing, and substance use. I ask these "
                "because they help us connect you to the right support — not to judge "
                "you or create any problems for you."
            ),
            "tips": [
                {
                    "type": "crisis",
                    "label": "If the member discloses a crisis",
                    "text": (
                        "Stop the questionnaire immediately. Acknowledge what the "
                        "member shared: \"Thank you for trusting me with that — it "
                        "takes courage to say it out loud.\" Do not move on to the "
                        "next question. Assess for immediate safety, activate your "
                        "crisis protocol, and contact your supervisor. Document the "
                        "disclosure and your response in the session notes."
                    ),
                },
                {
                    "type": "hesitant",
                    "label": "Sample transitions between sensitive sections",
                    "text": (
                        "When moving into medical questions after SDOH: "
                        "\"We have covered some of the life circumstances that can "
                        "affect your health. Now I want to ask a few questions about "
                        "your medical history — things like blood pressure and diabetes. "
                        "These help us make sure you are connected to the right care.\"\n\n"
                        "When moving into mental health: "
                        "\"The next few questions are about emotional wellbeing. "
                        "Mental health is just as important as physical health, "
                        "and asking about it is a normal part of this check-in. "
                        "There is absolutely no wrong answer.\"\n\n"
                        "When moving into substance use: "
                        "\"These next questions ask about alcohol and other substances. "
                        "This is a standard part of the health screening — we ask "
                        "everyone the same questions and we are not here to judge. "
                        "You can always skip a question if you prefer.\""
                    ),
                },
            ],
            "phrases": [
                "Take your time — I am not going anywhere.",
                "That question can be tough — you are doing great.",
                "We are almost done with this section. You are doing really well.",
                "I want to make sure I understood you correctly — did you mean…?",
                "There is no pressure. We can come back to that one.",
            ],
        },

        # ── Step 7 ─────────────────────────────────────────────────────────
        {
            "step": 7,
            "title": "Closing the Conversation",
            "script_text": (
                "Thank you so much for taking the time to go through this with me "
                "today. I know some of those questions were personal, and I really "
                "appreciate your openness. Based on what you shared, I will be "
                "putting together a list of resources and next steps that I think "
                "could be helpful for you. We can go over them now or I can follow "
                "up with you. Is there anything you want to add, or anything that "
                "came up during our conversation that you want to talk more about?"
            ),
            "tips": [
                {
                    "type": "hesitant",
                    "label": "If the member seems reluctant to end the session",
                    "text": (
                        "This is often a sign that the member has unmet needs or "
                        "is experiencing social isolation. Do not rush them out. "
                        "Take a few extra minutes to validate their experience and "
                        "clearly outline what happens next so they feel supported "
                        "beyond this conversation."
                    ),
                },
            ],
            "phrases": [
                "You did a great job today. I am really glad we connected.",
                "Here is what I will do next on my end: [summarise action items].",
                "If anything comes up before our next check-in, do not hesitate to reach out.",
                "Thank you for trusting me — it means a lot.",
                "I will follow up with you by [date/method] with those resources.",
            ],
        },
    ],

    # ── Quick Reference Phrase Library ──────────────────────────────────────
    "quick_reference_phrases": {
        "opening": [
            "Thank you for making time for this today.",
            "I am here to support you — not to judge you.",
            "This is a safe space.",
        ],
        "encouragement": [
            "You are doing great — thank you for being so open.",
            "That takes courage to share. I appreciate your trust.",
            "There is no right or wrong answer here.",
        ],
        "pacing": [
            "Take your time — we can go at whatever pace works for you.",
            "We can take a break whenever you need one.",
            "We can come back to that question if you want.",
        ],
        "transitions": [
            "Now we are moving into a section about [topic]. These questions are standard and help us…",
            "We are almost done — just a few more questions.",
            "That is the last question for this section. Great work.",
        ],
        "closing": [
            "Thank you so much for your time and openness today.",
            "Based on what you shared, I will look into resources for [need].",
            "I will follow up with you by [date] — here is how to reach me in the meantime.",
        ],
        "crisis_bridge": [
            "Thank you for telling me that. I take what you said seriously.",
            "I am going to pause here and make sure you are safe right now.",
            "You are not alone — let me figure out who we should call together.",
        ],
    },
}
