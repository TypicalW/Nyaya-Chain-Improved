import { Router } from "express";
import multer from "multer";
import { createHash, randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  registerEvidenceOnBlockchain,
  verifyEvidenceOnBlockchain,
} from "./blockchain.js";
import { recordCustodyEvent, recordIntegrityTransition } from "./custody.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

const env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
}).parse(process.env);

const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY
);

const evidenceSchema = z.object({
  firId: z.string().uuid(),
});

function isConfirmedMissingStorageObject(error: unknown) {
  const candidate = error as { statusCode?: number | string; message?: string } | null;
  const status = Number(candidate?.statusCode);
  const message = candidate?.message?.toLowerCase() ?? "";
  return status === 404 || message.includes("object not found");
}

async function setVerificationStatus(evidenceId: string, status: "Verified" | "Tampered" | "Missing" | "Pending") {
  const { error } = await supabase
    .from("evidence")
    .update({ verification_status: status })
    .eq("id", evidenceId);
  if (error) throw new Error(`Evidence status could not be updated: ${error.message}`);
}

async function recordVerificationFailure(input: {
  firId: string; evidenceId: string; fileName: string; source: string;
  category: string; checkedAt: string; failureReason: string;
  originalHash?: string; currentHash?: string;
}) {
  const dedupeKey = `verification-error:${input.category}`;
  const { data, error } = await supabase.from("custody_events")
    .select("id").eq("evidence_id", input.evidenceId)
    .eq("event_type", "EVIDENCE_VERIFICATION_FAILED")
    .contains("metadata", { dedupeKey }).limit(1);
  if (!error && data?.length) return;
  await recordCustodyEvent({
    firId: input.firId, evidenceId: input.evidenceId,
    eventType: "EVIDENCE_VERIFICATION_FAILED", source: input.source,
    summary: `Evidence verification could not be completed: ${input.fileName}`,
    metadata: { fileName: input.fileName, dedupeKey, verificationMethod: "Manual", checkedAt: input.checkedAt, failureReason: input.failureReason, ...(input.originalHash ? { originalHash: input.originalHash } : {}), ...(input.currentHash ? { currentHash: input.currentHash } : {}) },
  });
}


/*
 * =========================================================
 * UPLOAD EVIDENCE
 * =========================================================
 *
 * POST /api/evidence
 *
 * Flow:
 *
 * File
 *   ↓
 * SHA-256
 *   ↓
 * Supabase Storage
 *   ↓
 * Supabase evidence record
 *   ↓
 * EvidenceRegistry on Sepolia
 *   ↓
 * blockchain_tx_hash
 *   ↓
 * verification_status = Verified
 *
 * If blockchain registration fails:
 *
 * Evidence
 *   ↓
 * Supabase
 *   ↓
 * verification_status = Pending
 *
 * The evidence is NOT deleted because the blockchain
 * can be retried later.
 */

router.post(
  "/",
  upload.single("file"),
  async (request, response) => {
    try {
      if (!request.file) {
        return response.status(400).json({
          error: "Evidence file is required.",
        });
      }

      const { firId } = evidenceSchema.parse(request.body);

      // -----------------------------------------------------
      // 1. Verify that the FIR exists
      // -----------------------------------------------------

      const { data: fir, error: firError } = await supabase
        .from("firs")
        .select("id, fir_number")
        .eq("id", firId)
        .single();

      if (firError || !fir) {
        return response.status(404).json({
          error: "FIR not found.",
        });
      }

      // -----------------------------------------------------
      // 2. Calculate SHA-256 from the actual file bytes
      // -----------------------------------------------------

      const fileHash = createHash("sha256")
        .update(request.file.buffer)
        .digest("hex");

      // -----------------------------------------------------
      // 3. Create the Supabase Storage path
      // -----------------------------------------------------

      const storagePath =
        `${fir.fir_number}/${randomUUID()}-${request.file.originalname}`;

      // -----------------------------------------------------
      // 4. Upload the actual file to Supabase Storage
      // -----------------------------------------------------

      const { error: uploadError } = await supabase.storage
        .from("evidence")
        .upload(
          storagePath,
          request.file.buffer,
          {
            contentType: request.file.mimetype,
            upsert: false,
          }
        );

      if (uploadError) {
        throw new Error(
          `Evidence file could not be uploaded: ${uploadError.message}`
        );
      }

      // -----------------------------------------------------
      // 5. Store evidence metadata in Supabase
      // -----------------------------------------------------

      const { data: evidence, error: evidenceError } =
        await supabase
          .from("evidence")
          .insert({
            fir_id: firId,
            file_name: request.file.originalname,
            file_type: request.file.mimetype,
            storage_path: storagePath,
            file_hash: fileHash,
          })
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
          .single();

      if (evidenceError) {
        // Remove the Storage file if database insertion fails.
        await supabase.storage
          .from("evidence")
          .remove([storagePath]);

        throw new Error(
          `Evidence metadata could not be stored: ${evidenceError.message}`
        );
      }

      await recordCustodyEvent({
        firId,
        evidenceId: evidence.id,
        eventType: "EVIDENCE_UPLOADED",
        summary: `Evidence uploaded: ${evidence.file_name}`,
        metadata: {
          fileName: evidence.file_name,
          fileType: evidence.file_type,
          fileHash: evidence.file_hash,
          storagePath: evidence.storage_path,
        },
      });

      // -----------------------------------------------------
      // 6. Register the hash on the Sepolia blockchain
      // -----------------------------------------------------

      let blockchainTxHash: string | null = null;
      let verificationStatus = "Pending";

      try {
        const blockchainResult =
          await registerEvidenceOnBlockchain(
            fileHash,
            fir.fir_number
          );

        blockchainTxHash =
          blockchainResult.transactionHash;

        verificationStatus = "Verified";

        await recordCustodyEvent({
          firId,
          evidenceId: evidence.id,
          eventType: "BLOCKCHAIN_REGISTERED",
          source: "Blockchain",
          actorLabel: "Sepolia",
          summary: `Evidence anchored on blockchain: ${evidence.file_name}`,
          metadata: {
            fileName: evidence.file_name,
            fileHash: evidence.file_hash,
            transactionHash: blockchainTxHash,
            blockNumber: blockchainResult.blockNumber,
          },
        });

        console.log(
          "Evidence registered on blockchain:",
          blockchainTxHash
        );
      } catch (blockchainError) {
        /*
         * The evidence itself is already safely stored.
         *
         * If the blockchain is temporarily unavailable,
         * leave the record as Pending rather than deleting
         * legitimate evidence.
         */
        console.error(
          "Blockchain registration failed:",
          blockchainError
        );

        await recordCustodyEvent({
          firId,
          evidenceId: evidence.id,
          eventType: "BLOCKCHAIN_REGISTRATION_PENDING",
          source: "Blockchain",
          actorLabel: "Sepolia",
          summary: `Blockchain registration pending: ${evidence.file_name}`,
          metadata: { fileName: evidence.file_name, fileHash: evidence.file_hash },
        });
      }

      // -----------------------------------------------------
      // 7. Store blockchain information in Supabase
      // -----------------------------------------------------

      const { error: blockchainUpdateError } =
        await supabase
          .from("evidence")
          .update({
            blockchain_tx_hash: blockchainTxHash,
            verification_status: verificationStatus,
          })
          .eq("id", evidence.id);

      if (blockchainUpdateError) {
        throw new Error(`Blockchain registration completed, but evidence metadata could not be updated: ${blockchainUpdateError.message}`);
      }

      // -----------------------------------------------------
      // 8. Return the complete evidence record
      // -----------------------------------------------------

      return response.status(201).json({
        evidence: {
          id: evidence.id,
          firId: evidence.fir_id,
          fileName: evidence.file_name,
          fileType: evidence.file_type,
          storagePath: evidence.storage_path,
          fileHash: evidence.file_hash,
          uploadedAt: evidence.uploaded_at,
          blockchainTxHash,
          verificationStatus,
        },
      });

    } catch (error) {
      console.error(
        "Evidence upload failed:",
        error
      );

      return response.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Unable to upload evidence.",
      });
    }
  }
);


/*
 * =========================================================
 * VERIFY EVIDENCE
 * =========================================================
 *
 * GET /api/evidence/:id/verify
 *
 * Flow:
 *
 * Evidence ID
 *   ↓
 * Retrieve evidence metadata
 *   ↓
 * Retrieve FIR number
 *   ↓
 * Download actual file
 *   ↓
 * Calculate SHA-256 again
 *   ↓
 * Compare with original database hash
 *   ↓
 * Query blockchain
 *   ↓
 * Compare blockchain FIR number
 *   ↓
 * Verified / Tampered
 */

router.get("/:id/verify", async (request, response) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const checkedAt = new Date().toISOString();
    const { data: evidence, error: evidenceError } = await supabase
      .from("evidence")
      .select("id, fir_id, file_name, storage_path, file_hash, blockchain_tx_hash, verification_status")
      .eq("id", id)
      .single();
    if (evidenceError || !evidence) return response.status(404).json({ error: "Evidence not found." });

    const { data: fir, error: firError } = await supabase
      .from("firs")
      .select("id, fir_number")
      .eq("id", evidence.fir_id)
      .single();
    if (firError || !fir) return response.status(404).json({ error: "Associated FIR not found." });

    const base = {
      evidenceId: evidence.id,
      firId: evidence.fir_id,
      firNumber: fir.fir_number,
      originalHash: evidence.file_hash,
      blockchain: { exists: false, firNumber: null, firNumberMatches: false, timestamp: null, uploadedBy: null, transactionHash: evidence.blockchain_tx_hash },
      checkedAt,
      verificationMethod: "Manual" as const,
    };
    const { data: file, error: downloadError } = await supabase.storage.from("evidence").download(evidence.storage_path);

    if (downloadError || !file) {
      if (downloadError && isConfirmedMissingStorageObject(downloadError)) {
        await setVerificationStatus(evidence.id, "Missing");
        await recordIntegrityTransition({
          firId: evidence.fir_id, evidenceId: evidence.id, eventType: "EVIDENCE_MISSING", source: "Integrity verifier",
          summary: `Evidence file unavailable during manual verification: ${evidence.file_name}`,
          metadata: { fileName: evidence.file_name, storagePath: evidence.storage_path, originalHash: evidence.file_hash, previousStatus: evidence.verification_status, nextStatus: "Missing", verificationMethod: "Manual", checkedAt },
        });
        return response.json({ verification: { ...base, currentHash: null, fileHashMatches: null, verified: false, status: "Missing" } });
      }

      const failureReason = downloadError?.message ?? "Storage returned no file data.";
      await recordVerificationFailure({ firId: evidence.fir_id, evidenceId: evidence.id, fileName: evidence.file_name, source: "Integrity verifier", category: "storage-unavailable", checkedAt, failureReason });
      return response.json({ verification: { ...base, currentHash: null, fileHashMatches: null, verified: false, status: "Verification Error", verificationError: failureReason } });
    }

    const currentHash = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
    const fileHashMatches = currentHash === evidence.file_hash;
    if (!fileHashMatches) {
      await setVerificationStatus(evidence.id, "Tampered");
      await recordIntegrityTransition({
        firId: evidence.fir_id, evidenceId: evidence.id, eventType: "EVIDENCE_TAMPERED", source: "Integrity verifier",
        summary: `Evidence file hash does not match: ${evidence.file_name}`,
        metadata: { fileName: evidence.file_name, originalHash: evidence.file_hash, currentHash, fileHashMatches, previousStatus: evidence.verification_status, nextStatus: "Tampered", verificationMethod: "Manual", checkedAt },
      });
      return response.json({ verification: { ...base, currentHash, fileHashMatches, verified: false, status: "Tampered" } });
    }

    if (evidence.verification_status === "Missing") await recordIntegrityTransition({
      firId: evidence.fir_id, evidenceId: evidence.id, eventType: "EVIDENCE_RECOVERED", source: "Integrity verifier",
      summary: `Previously missing evidence is available again: ${evidence.file_name}`,
      metadata: { fileName: evidence.file_name, previousStatus: "Missing", verificationMethod: "Manual", checkedAt },
    });

    let blockchainRecord: Awaited<ReturnType<typeof verifyEvidenceOnBlockchain>>;
    try {
      blockchainRecord = await verifyEvidenceOnBlockchain(evidence.file_hash);
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : "Blockchain verification could not be completed.";
      await recordVerificationFailure({ firId: evidence.fir_id, evidenceId: evidence.id, fileName: evidence.file_name, source: "Blockchain", category: "rpc-unavailable", checkedAt, failureReason, originalHash: evidence.file_hash, currentHash });
      return response.json({ verification: { ...base, currentHash, fileHashMatches, verified: false, status: "Verification Error", verificationError: failureReason } });
    }

    const blockchainFirMatches = blockchainRecord.exists && blockchainRecord.firNumber === fir.fir_number;
    const blockchain = { exists: blockchainRecord.exists, firNumber: blockchainRecord.firNumber, firNumberMatches: blockchainFirMatches, timestamp: blockchainRecord.timestamp, uploadedBy: blockchainRecord.uploadedBy, transactionHash: evidence.blockchain_tx_hash };
    if (!blockchainRecord.exists || !blockchainFirMatches) {
      await recordVerificationFailure({ firId: evidence.fir_id, evidenceId: evidence.id, fileName: evidence.file_name, source: "Blockchain", category: blockchainRecord.exists ? "fir-mismatch" : "record-absent", checkedAt, failureReason: "Blockchain record is missing or does not match this FIR.", originalHash: evidence.file_hash, currentHash });
      return response.json({ verification: { ...base, currentHash, fileHashMatches, blockchain, verified: false, status: "Verification Error", verificationError: "Blockchain record is missing or does not match this FIR." } });
    }

    await setVerificationStatus(evidence.id, "Verified");
    await recordIntegrityTransition({
      firId: evidence.fir_id, evidenceId: evidence.id, eventType: "EVIDENCE_VERIFIED", source: "Integrity verifier",
      summary: `Evidence integrity verified: ${evidence.file_name}`,
      metadata: { fileName: evidence.file_name, originalHash: evidence.file_hash, currentHash, fileHashMatches, blockchainExists: true, blockchainFirMatches: true, previousStatus: evidence.verification_status, nextStatus: "Verified", verificationMethod: "Manual", checkedAt },
    });
    return response.json({ verification: { ...base, currentHash, fileHashMatches, blockchain, verified: true, status: "Verified" } });
  } catch (error) {
    console.error("Evidence verification failed:", error);
    return response.status(500).json({ error: error instanceof Error ? error.message : "Unable to verify evidence." });
  }
});


/*
 * =========================================================
 * LIST EVIDENCE FOR FIR
 * =========================================================
 *
 * GET /api/evidence/fir/:firId
 */

router.get(
  "/fir/:firId",
  async (request, response) => {
    try {
      const { firId } = z.object({
        firId: z.string().uuid(),
      }).parse(request.params);

      // Verify that the FIR exists.
      const { data: fir, error: firError } = await supabase
        .from("firs")
        .select("id, fir_number")
        .eq("id", firId)
        .single();

      if (firError || !fir) {
        return response.status(404).json({
          error: "FIR not found.",
        });
      }

      // Retrieve all evidence belonging to the FIR.
      const { data: evidence, error: evidenceError } =
        await supabase
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
          .eq("fir_id", firId)
          .order("uploaded_at", {
            ascending: false,
          });

      if (evidenceError) {
        throw new Error(
          `Unable to load evidence: ${evidenceError.message}`
        );
      }

      return response.json({
        fir: {
          id: fir.id,
          firNumber: fir.fir_number,
        },

        evidence: evidence.map((item) => ({
          id: item.id,
          firId: item.fir_id,
          fileName: item.file_name,
          fileType: item.file_type,
          storagePath: item.storage_path,
          fileHash: item.file_hash,
          blockchainTxHash:
            item.blockchain_tx_hash,
          verificationStatus:
            item.verification_status,
          uploadedAt:
            item.uploaded_at,
        })),
      });

    } catch (error) {
      console.error(
        "Evidence listing failed:",
        error
      );

      return response.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Unable to load evidence.",
      });
    }
  }
);


/*
 * =========================================================
 * RETRY BLOCKCHAIN REGISTRATION
 * =========================================================
 *
 * POST /api/evidence/:id/register
 *
 * Used when evidence was successfully stored in Supabase
 * but blockchain registration was not completed.
 *
 * Pending
 *   ↓
 * Verify hash on blockchain
 *   ↓
 * Already exists → mark Verified
 *   ↓
 * Does not exist → register on Sepolia
 *   ↓
 * Save transaction hash
 *   ↓
 * Verified
 *
 * IMPORTANT:
 *
 * We deliberately DO NOT use eth_getLogs/queryFilter here.
 *
 * The RPC provider's free tier limits historical log queries
 * to a very small block range.
 *
 * New evidence already gets its transaction hash directly
 * from registerEvidenceOnBlockchain().
 */

router.post(
  "/:id/register",
  async (request, response) => {
    try {
      const { id } = z.object({
        id: z.string().uuid(),
      }).parse(request.params);

      // -----------------------------------------------------
      // 1. Find evidence
      // -----------------------------------------------------

      const { data: evidence, error: evidenceError } =
        await supabase
          .from("evidence")
          .select(`
            id,
            fir_id,
            file_name,
            storage_path,
            file_hash,
            blockchain_tx_hash,
            verification_status
          `)
          .eq("id", id)
          .single();

      if (evidenceError || !evidence) {
        return response.status(404).json({
          error: "Evidence not found.",
        });
      }

      // -----------------------------------------------------
      // 2. Find the FIR number
      // -----------------------------------------------------

      const { data: fir, error: firError } =
        await supabase
          .from("firs")
          .select("id, fir_number")
          .eq("id", evidence.fir_id)
          .single();

      if (firError || !fir) {
        return response.status(404).json({
          error: "Associated FIR not found.",
        });
      }

      // A retry may anchor the immutable original hash, but it must never
      // certify a missing or modified Storage object as currently verified.
      const { data: storedFile, error: storedFileError } = await supabase.storage
        .from("evidence")
        .download(evidence.storage_path);
      if (storedFileError || !storedFile) {
        if (storedFileError && isConfirmedMissingStorageObject(storedFileError)) {
          await setVerificationStatus(evidence.id, "Missing");
          await recordIntegrityTransition({
            firId: evidence.fir_id, evidenceId: evidence.id, eventType: "EVIDENCE_MISSING", source: "Integrity verifier",
            summary: `Evidence file unavailable during blockchain registration retry: ${evidence.file_name}`,
            metadata: { fileName: evidence.file_name, storagePath: evidence.storage_path, originalHash: evidence.file_hash, previousStatus: evidence.verification_status, nextStatus: "Missing", verificationMethod: "Manual registration retry" },
          });
          return response.status(409).json({ error: "Evidence file is missing from Supabase Storage; blockchain registration was not retried.", verificationStatus: "Missing" });
        }
        throw new Error(`Evidence file could not be checked before blockchain registration: ${storedFileError?.message ?? "Storage returned no file data."}`);
      }
      const storedHash = createHash("sha256").update(Buffer.from(await storedFile.arrayBuffer())).digest("hex");
      if (storedHash !== evidence.file_hash) {
        await setVerificationStatus(evidence.id, "Tampered");
        await recordIntegrityTransition({
          firId: evidence.fir_id, evidenceId: evidence.id, eventType: "EVIDENCE_TAMPERED", source: "Integrity verifier",
          summary: `Evidence file hash does not match during blockchain registration retry: ${evidence.file_name}`,
          metadata: { fileName: evidence.file_name, originalHash: evidence.file_hash, currentHash: storedHash, previousStatus: evidence.verification_status, nextStatus: "Tampered", verificationMethod: "Manual registration retry" },
        });
        return response.status(409).json({ error: "Evidence file has changed; blockchain registration was not retried.", verificationStatus: "Tampered" });
      }

      // -----------------------------------------------------
      // 3. Check whether the hash already exists
      //    on the blockchain.
      // -----------------------------------------------------

      const existing =
        await verifyEvidenceOnBlockchain(
          evidence.file_hash
        );

      // -----------------------------------------------------
      // 4. Hash already exists on blockchain
      // -----------------------------------------------------

      if (existing.exists) {

        if (existing.firNumber !== fir.fir_number) {
          return response.status(409).json({ error: "The existing blockchain record is associated with a different FIR; evidence was not marked Verified." });
        }

        /*
         * We know the evidence is anchored on-chain.
         *
         * We deliberately do NOT try to recover the historical
         * transaction hash because that requires eth_getLogs,
         * which is restricted by the current RPC free tier.
         *
         * For records created by the current system,
         * blockchain_tx_hash is already populated.
         *
         * Older test records may therefore have:
         *
         * blockchain_tx_hash = null
         * verification_status = Verified
         */

        const { data: updatedEvidence, error: updateError } =
          await supabase
            .from("evidence")
            .update({
              verification_status: "Verified",
            })
            .eq("id", evidence.id)
            .select(`
              id,
              fir_id,
              file_name,
              file_type,
              storage_path,
              file_hash,
              blockchain_tx_hash,
              verification_status,
              uploaded_at
            `)
            .single();

        if (updateError || !updatedEvidence) {
          throw new Error(
            `Evidence status could not be updated: ${
              updateError?.message ?? "Unknown error"
            }`
          );
        }

        if (evidence.verification_status !== "Verified" || !evidence.blockchain_tx_hash) await recordCustodyEvent({
          firId: evidence.fir_id,
          evidenceId: evidence.id,
          eventType: "BLOCKCHAIN_REGISTERED",
          source: "Blockchain",
          actorLabel: "Sepolia",
          summary: "Existing blockchain evidence record confirmed",
          metadata: { fileHash: evidence.file_hash, transactionHash: updatedEvidence.blockchain_tx_hash },
        });

        return response.json({
          message:
            "Evidence hash already exists on the blockchain.",

          evidence: {
            id: updatedEvidence.id,
            firId: updatedEvidence.fir_id,
            fileName: updatedEvidence.file_name,
            fileType: updatedEvidence.file_type,
            storagePath: updatedEvidence.storage_path,
            fileHash: updatedEvidence.file_hash,
            blockchainTxHash:
              updatedEvidence.blockchain_tx_hash,
            verificationStatus:
              updatedEvidence.verification_status,
            uploadedAt:
              updatedEvidence.uploaded_at,
          },

          blockchain: {
            exists: true,
            firNumber:
              existing.firNumber,
            timestamp:
              existing.timestamp,
            uploadedBy:
              existing.uploadedBy,
          },
        });
      }

      // -----------------------------------------------------
      // 5. Hash does not exist on blockchain
      //
      // Register it now.
      // -----------------------------------------------------

      const blockchainResult =
        await registerEvidenceOnBlockchain(
          evidence.file_hash,
          fir.fir_number
        );

      // -----------------------------------------------------
      // 6. Save transaction hash and verification status
      // -----------------------------------------------------

      const { data: updatedEvidence, error: updateError } =
        await supabase
          .from("evidence")
          .update({
            blockchain_tx_hash:
              blockchainResult.transactionHash,

            verification_status:
              "Verified",
          })
          .eq("id", evidence.id)
          .select(`
            id,
            fir_id,
            file_name,
            file_type,
            storage_path,
            file_hash,
            blockchain_tx_hash,
            verification_status,
            uploaded_at
          `)
          .single();

      if (updateError || !updatedEvidence) {
        throw new Error(
          `Blockchain registration succeeded, but evidence metadata could not be updated: ${
            updateError?.message ?? "Unknown error"
          }`
        );
      }

      await recordCustodyEvent({
        firId: evidence.fir_id,
        evidenceId: evidence.id,
        eventType: "BLOCKCHAIN_REGISTERED",
        source: "Blockchain",
        actorLabel: "Sepolia",
        summary: "Evidence anchored on blockchain after retry",
        metadata: { fileHash: evidence.file_hash, transactionHash: blockchainResult.transactionHash, blockNumber: blockchainResult.blockNumber },
      });

      // -----------------------------------------------------
      // 7. Return result
      // -----------------------------------------------------

      return response.json({
        message:
          "Evidence successfully registered on the blockchain.",

        evidence: {
          id: updatedEvidence.id,
          firId: updatedEvidence.fir_id,
          fileName: updatedEvidence.file_name,
          fileType: updatedEvidence.file_type,
          storagePath: updatedEvidence.storage_path,
          fileHash: updatedEvidence.file_hash,
          blockchainTxHash:
            updatedEvidence.blockchain_tx_hash,
          verificationStatus:
            updatedEvidence.verification_status,
          uploadedAt:
            updatedEvidence.uploaded_at,
        },

        blockchain: {
          exists: true,
          transactionHash:
            blockchainResult.transactionHash,
          blockNumber:
            blockchainResult.blockNumber,
        },
      });

    } catch (error) {

      console.error(
        "Blockchain evidence registration failed:",
        error
      );

      return response.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Unable to register evidence on the blockchain.",
      });
    }
  }
);


export default router;
