import "dotenv/config"
import cors from "cors"
import express from "express"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { createClient } from "@supabase/supabase-js"
import nodemailer from "nodemailer"
import { Resend } from "resend"
import { z } from "zod"
import evidenceRouter from "./evidence.js"
import custodyRouter, { recordCustodyEvent } from "./custody.js"

const env = z.object({
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().url().default("http://localhost:3000"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite"),
  EMAIL_PROVIDER: z.enum(["resend", "smtp"]).default("resend"),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1),
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().email().optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (value.EMAIL_PROVIDER === "resend" && !value.RESEND_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "RESEND_API_KEY is required when EMAIL_PROVIDER=resend.",
      path: ["RESEND_API_KEY"],
    })
  }

  if (
    value.EMAIL_PROVIDER === "smtp" &&
    (!value.SMTP_USER || !value.SMTP_PASSWORD)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "SMTP_USER and SMTP_PASSWORD are required when EMAIL_PROVIDER=smtp.",
      path: ["SMTP_USER"],
    })
  }
}).parse(process.env)

const firSchema = z.object({
  complainantName: z.string().trim().min(2).max(120),
  complainantEmail: z.string().trim().email(),
  incidentDate: z.string().date(),
  location: z.string().trim().min(2).max(300),
  description: z.string().trim().min(20).max(10000),
})

const analysisInputSchema = firSchema.pick({
  description: true,
  incidentDate: true,
  location: true,
})

const firStatuses = [
  "Registered",
  "Under Review",
  "Investigation Open",
  "Evidence Pending",
  "Charge Sheet Filed",
  "Closed",
] as const

const statusSchema = z.object({
  status: z.enum(firStatuses),
})

const analysisSchema = z.object({
  summary: z.string(),

  recommendations: z.array(
    z.object({
      law: z.string(),
      section: z.string(),
      title: z.string(),
      rationale: z.string(),
      confidence: z.number().min(0).max(100),
    })
  ).max(8),

  victimActions: z.array(z.string()).max(8),

  disclaimer: z.string(),
})

type LegalAnalysis = z.infer<typeof analysisSchema>

const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY
)

const gemini = new GoogleGenerativeAI(
  env.GEMINI_API_KEY
)

const resend =
  env.EMAIL_PROVIDER === "resend"
    ? new Resend(env.RESEND_API_KEY)
    : null

const smtpTransport =
  env.EMAIL_PROVIDER === "smtp"
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASSWORD,
        },
      })
    : null


// =========================================================
// AI FIR ANALYSIS
// =========================================================

async function analyseFir(
  input: z.infer<typeof analysisInputSchema>
): Promise<LegalAnalysis> {

  const prompt = `You are a legal-information assistant for an Indian FIR intake system. Analyse only the supplied report. Return JSON only, following this exact schema: {"summary":"string","recommendations":[{"law":"string","section":"string","title":"string","rationale":"string","confidence":0}],"victimActions":["string"],"disclaimer":"string"}. Use current Indian law: Bharatiya Nyaya Sanhita, 2023 (BNS) is the operative criminal code. Include the corresponding IPC section only when a reliable equivalent is useful, clearly labelled as a legacy IPC reference. Include constitutional rights only where directly relevant. Do not claim guilt, do not fabricate facts, use cautious language, and say the suggestions require verification by a qualified legal professional. Incident date: ${input.incidentDate}. Location: ${input.location}. FIR narrative: ${input.description}`

  const model = gemini.getGenerativeModel({
    model: env.GEMINI_MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  })

  const result = await model.generateContent(prompt)

  const parsed = JSON.parse(
    result.response.text()
  )

  return analysisSchema.parse(parsed)
}


// =========================================================
// FIR NUMBER GENERATION
// =========================================================

function firNumber() {
  return `FIR-${new Date().getUTCFullYear()}-${crypto
    .randomUUID()
    .slice(0, 8)
    .toUpperCase()}`
}


// =========================================================
// REGISTRATION EMAIL
// =========================================================

function registrationEmail(
  name: string,
  number: string
) {
  return {
    subject: `FIR registered: ${number}`,

    html: `
      <p>Dear ${name},</p>

      <p>
        Your First Information Report has been
        registered successfully.
      </p>

      <p>
        <strong>FIR number:</strong> ${number}
      </p>

      <p>
        Please retain this number for future
        correspondence with the police station.
      </p>

      <p>Nyaya-Chain</p>
    `,
  }
}


async function sendRegistrationEmail(
  recipient: string,
  name: string,
  number: string
) {

  const email = registrationEmail(
    name,
    number
  )

  if (env.EMAIL_PROVIDER === "smtp") {

    await smtpTransport!.sendMail({
      from: env.EMAIL_FROM,
      to: recipient,
      ...email,
    })

    return
  }

  const result =
    await resend!.emails.send({
      from: env.EMAIL_FROM,
      to: recipient,
      ...email,
    })

  if (result.error) {
    throw new Error(
      result.error.message
    )
  }
}


// =========================================================
// EXPRESS APPLICATION
// =========================================================

const app = express()

app.use(
  cors({
    origin: env.CORS_ORIGIN,
  })
)

app.use(
  express.json({
    limit: "1mb",
  })
)


// =========================================================
// HEALTH CHECK
// =========================================================

app.get(
  "/health",
  (_request, response) =>
    response.json({
      status: "ok",
    })
)


// =========================================================
// AI FIR ANALYSIS
// =========================================================

app.post(
  "/api/firs/analyze",
  async (request, response) => {

    try {

      const input =
        analysisInputSchema.parse(
          request.body
        )

      response.json(
        await analyseFir(input)
      )

    } catch (error) {

      response.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Unable to analyse this FIR.",
      })
    }
  }
)


// =========================================================
// CREATE FIR
// =========================================================

app.post(
  "/api/firs",
  async (request, response) => {

    try {

      const input =
        firSchema.parse(
          request.body
        )

      let analysis: LegalAnalysis
      let aiAvailable = true

      // -----------------------------------------------------
      // Run AI analysis
      // -----------------------------------------------------

      try {

        analysis =
          await analyseFir(input)

      } catch (aiError) {

        console.error(
          "AI analysis failed:",
          aiError
        )

        aiAvailable = false

        analysis = {
          summary:
            "AI legal analysis is temporarily unavailable.",

          recommendations: [],

          victimActions: [
            "Keep all available evidence related to the incident.",
            "Wait for the investigating officer to review your complaint.",
          ],

          disclaimer:
            "The FIR has been successfully registered, but AI analysis could not be generated due to a temporary service issue. A qualified legal professional should review this complaint.",
        }
      }

      // -----------------------------------------------------
      // Generate FIR number
      // -----------------------------------------------------

      const number = firNumber()

      // -----------------------------------------------------
      // Store FIR
      // -----------------------------------------------------

      const {
        data: fir,
        error,
      } = await supabase
        .from("firs")
        .insert({
          fir_number: number,
          complainant_name:
            input.complainantName,
          complainant_email:
            input.complainantEmail,
          incident_date:
            input.incidentDate,
          location:
            input.location,
          description:
            input.description,
          legal_analysis:
            analysis,
        })
        .select(
          "id, fir_number"
        )
        .single()

      if (error) {

        throw new Error(
          `FIR could not be stored: ${error.message}`
        )
      }

      await recordCustodyEvent({
        firId: fir.id,
        eventType: "FIR_REGISTERED",
        summary: "FIR registered",
        metadata: { firNumber: fir.fir_number },
      })

      await recordCustodyEvent({
        firId: fir.id,
        eventType: aiAvailable ? "AI_ANALYSIS_COMPLETED" : "AI_ANALYSIS_FALLBACK",
        source: "Legal analysis service",
        summary: aiAvailable ? "Legal information analysis completed" : "AI analysis unavailable; safe fallback guidance recorded",
        metadata: { aiAvailable },
      })

      // -----------------------------------------------------
      // Send registration email
      // -----------------------------------------------------

      let emailSent = false

      try {

        await sendRegistrationEmail(
          input.complainantEmail,
          input.complainantName,
          number
        )

        emailSent = true

        await supabase
          .from("firs")
          .update({
            email_sent_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            fir.id
          )

        await recordCustodyEvent({
          firId: fir.id,
          eventType: "REGISTRATION_EMAIL_SENT",
          source: "Email service",
          summary: "Registration confirmation email sent",
          metadata: { recipient: input.complainantEmail },
        })

      } catch (mailError) {

        console.error(
          "Registration email failed:",
          mailError
        )

        await recordCustodyEvent({
          firId: fir.id,
          eventType: "REGISTRATION_EMAIL_FAILED",
          source: "Email service",
          summary: "Registration confirmation email could not be sent",
        })
      }

      // -----------------------------------------------------
      // Response
      // -----------------------------------------------------

      response.status(201).json({

        fir: {
          id: fir.id,
          firNumber:
            fir.fir_number,
        },

        analysis,

        emailSent,

        aiAvailable,
      })

    } catch (error) {

      response.status(400).json({

        error:
          error instanceof Error
            ? error.message
            : "Unable to register the FIR.",
      })
    }
  }
)


// =========================================================
// LIST FIRs
// =========================================================

app.get(
  "/api/firs",
  async (request, response) => {

    const limit =
      Math.min(
        Math.max(
          Number(
            request.query.limit
          ) || 8,
          1
        ),
        50
      )

    const {
      data,
      error,
    } = await supabase
      .from("firs")
      .select(
        `
        id,
        fir_number,
        complainant_name,
        incident_date,
        status,
        created_at
        `
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      )
      .limit(limit)

    // if (error) {

    //   return response
    //     .status(500)
    //     .json({
    //       error:
    //         "Unable to load FIR registrations.",
    //     })
    // }

if (error) {
  console.error("SUPABASE FIR FETCH ERROR:", error);

  return response
    .status(500)
    .json({
      error: "Unable to load FIR registrations.",
      details: error.message,
      code: error.code,
      hint: error.hint,
    });
}




    response.json({
      firs: data.map(
        (fir) => ({
          id: fir.id,
          firNumber:
            fir.fir_number,
          complainantName:
            fir.complainant_name,
          incidentDate:
            fir.incident_date,
          status:
            fir.status,
          createdAt:
            fir.created_at,
        })
      ),
    })
  }
)


// =========================================================
// GET SINGLE FIR + EVIDENCE
// =========================================================
//
// GET /api/firs/:id
//
// Returns:
//
// FIR
// ├── complainant information
// ├── incident information
// ├── status
// ├── AI legal analysis
// └── evidence
//     ├── SHA-256 hash
//     ├── blockchain transaction
//     └── verification status
//
// This is intended to be the primary endpoint
// used by the frontend FIR details page.
// =========================================================

app.get(
  "/api/firs/:id",
  async (request, response) => {

    try {

      const { id } =
        z.object({
          id: z.string().uuid(),
        }).parse(
          request.params
        )

      // -----------------------------------------------------
      // Get FIR
      // -----------------------------------------------------

      const {
        data: fir,
        error: firError,
      } = await supabase
        .from("firs")
        .select(
          `
          id,
          fir_number,
          complainant_name,
          complainant_email,
          incident_date,
          location,
          description,
          status,
          legal_analysis,
          email_sent_at,
          created_at
          `
        )
        .eq(
          "id",
          id
        )
        .single()

      if (
        firError ||
        !fir
      ) {

        return response
          .status(404)
          .json({
            error:
              "FIR not found.",
          })
      }

      // -----------------------------------------------------
      // Get evidence belonging to FIR
      // -----------------------------------------------------

      const {
        data: evidence,
        error: evidenceError,
      } = await supabase
        .from("evidence")
        .select(
          `
          id,
          fir_id,
          file_name,
          file_type,
          storage_path,
          file_hash,
          blockchain_tx_hash,
          verification_status,
          uploaded_at
          `
        )
        .eq(
          "fir_id",
          id
        )
        .order(
          "uploaded_at",
          {
            ascending: false,
          }
        )

      if (evidenceError) {

        throw new Error(
          `Unable to load FIR evidence: ${evidenceError.message}`
        )
      }

      // -----------------------------------------------------
      // Return complete FIR
      // -----------------------------------------------------

      return response.json({

        fir: {

          id: fir.id,

          firNumber:
            fir.fir_number,

          complainantName:
            fir.complainant_name,

          complainantEmail:
            fir.complainant_email,

          incidentDate:
            fir.incident_date,

          location:
            fir.location,

          description:
            fir.description,

          status:
            fir.status,

          legalAnalysis:
            fir.legal_analysis,

          emailSentAt:
            fir.email_sent_at,

          createdAt:
            fir.created_at,
        },

        evidence:
          evidence.map(
            (item) => ({

              id: item.id,

              firId:
                item.fir_id,

              fileName:
                item.file_name,

              fileType:
                item.file_type,

              storagePath:
                item.storage_path,

              fileHash:
                item.file_hash,

              blockchainTxHash:
                item.blockchain_tx_hash,

              verificationStatus:
                item.verification_status,

              uploadedAt:
                item.uploaded_at,
            })
          ),
      })

    } catch (error) {

      console.error(
        "FIR details retrieval failed:",
        error
      )

      return response
        .status(400)
        .json({

          error:
            error instanceof Error
              ? error.message
              : "Unable to load FIR details.",
        })
    }
  }
)


// =========================================================
// UPDATE FIR STATUS
// =========================================================

app.patch(
  "/api/firs/:id/status",
  async (request, response) => {

    try {

      const { id } =
        z.object({
          id: z.string().uuid(),
        }).parse(
          request.params
        )

      const {
        status,
      } =
        statusSchema.parse(
          request.body
        )

      const { data: existingFir, error: existingFirError } = await supabase
        .from("firs")
        .select("status")
        .eq("id", id)
        .single()

      if (existingFirError || !existingFir) {
        return response.status(404).json({ error: "FIR not found or its status could not be updated." })
      }

      const {
        data: fir,
        error,
      } = await supabase
        .from("firs")
        .update({
          status,
        })
        .eq(
          "id",
          id
        )
        .select(
          `
          id,
          fir_number,
          complainant_name,
          incident_date,
          status,
          created_at
          `
        )
        .single()

      if (
        error ||
        !fir
      ) {

        return response
          .status(404)
          .json({
            error:
              "FIR not found or its status could not be updated.",
          })
      }

      if (existingFir.status !== fir.status) {
        await recordCustodyEvent({
          firId: fir.id,
          eventType: "CASE_STATUS_CHANGED",
          summary: `Case status changed from ${existingFir.status} to ${fir.status}`,
          metadata: { previousStatus: existingFir.status, nextStatus: fir.status },
        })
      }

      response.json({

        fir: {

          id: fir.id,

          firNumber:
            fir.fir_number,

          complainantName:
            fir.complainant_name,

          incidentDate:
            fir.incident_date,

          status:
            fir.status,

          createdAt:
            fir.created_at,
        },
      })

    } catch (error) {

      response
        .status(400)
        .json({

          error:
            error instanceof Error
              ? error.message
              : "Invalid FIR status.",
        })
    }
  }
)


// =========================================================
// EVIDENCE ROUTER
// =========================================================
//
// Handles:
//
// POST /api/evidence
// GET  /api/evidence/fir/:firId
// GET  /api/evidence/:id/verify
//
// Blockchain registration and verification are
// handled inside evidence.ts.
// =========================================================

app.use(
  "/api/evidence",
  evidenceRouter
)

app.use(
  "/api/custody",
  custodyRouter
)


// =========================================================
// START SERVER
// =========================================================

app.listen(
  env.PORT,
  () =>
    console.log(
      `Nyaya-Chain API listening on port ${env.PORT}`
    )
)
