/**
 * CredentialUploadModal — multi-step modal for CHWs to upload credential documents.
 *
 * Step 1 — Pick document (PDF / JPG / PNG, max 10 MB).
 * Step 2 — Fill credential metadata: type, programme name, certificate number,
 *           institution name, expiry date.
 * Step 3 — Submit: POST /credentials/validate → presigned PUT → S3 upload
 *           → PATCH credential record with document_s3_key.
 *
 * Platform behaviour:
 *  - Native (iOS / Android): expo-document-picker is used directly.
 *  - Web: shows a "please use the mobile app" fallback because the presigned
 *    PUT flow has inconsistent CORS behaviour across web environments and has
 *    not been validated end-to-end on web.
 *
 * HIPAA note:
 *  - No file name, S3 key, or upload URL is logged to the console.
 *  - Error messages surfaced to the user are generic — they do NOT include
 *    the original file name or S3 path.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import {
  X,
  FileText,
  Upload,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { uploadFile } from '../../api/upload';
import {
  useSubmitCredential,
  usePatchCredentialDocument,
  type SubmitCredentialPayload,
} from '../../hooks/useApiQueries';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
]);

const ALLOWED_EXTENSIONS_DISPLAY = 'PDF, JPG, or PNG';

/** Maps a friendly credential type label to the programme name placeholder. */
const CREDENTIAL_TYPE_OPTIONS: ReadonlyArray<{
  value: CredentialType;
  label: string;
  placeholder: string;
}> = [
  { value: 'license', label: 'License', placeholder: 'e.g. CHW License, RN License' },
  { value: 'certification', label: 'Certification', placeholder: 'e.g. CHW Certification, CPR Cert' },
  { value: 'training_certificate', label: 'Training Certificate', placeholder: 'e.g. HIPAA Training, CPI Training' },
];

// ─── Local types ──────────────────────────────────────────────────────────────

type CredentialType = 'license' | 'certification' | 'training_certificate';

interface PickedDocument {
  /** Local file URI — not logged anywhere (HIPAA). */
  uri: string;
  /** Sanitised display name shown in the UI (name without the path). */
  displayName: string;
  mimeType: string;
  sizeBytes: number;
}

interface FormState {
  credentialType: CredentialType;
  programName: string;
  institutionName: string;
  certificateNumber: string;
  expiryDate: string;
}

const EMPTY_FORM: FormState = {
  credentialType: 'certification',
  programName: '',
  institutionName: '',
  certificateNumber: '',
  expiryDate: '',
};

type UploadStep = 'pick' | 'form' | 'uploading' | 'success' | 'error';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CredentialUploadModalProps {
  visible: boolean;
  onClose: () => void;
  /** Called after a successful upload so the parent can refresh its list. */
  onUploaded?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format bytes as a human-readable string (e.g. "2.3 MB"). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Returns true when a date string matches YYYY-MM-DD and is a valid date. */
function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  return !isNaN(parsed.getTime());
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  errorMessage?: string;
  required?: boolean;
  keyboardType?: 'default' | 'numeric';
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  errorMessage,
  required = false,
  keyboardType = 'default',
}: FieldProps): React.JSX.Element {
  return (
    <View style={fieldStyles.container}>
      <Text style={fieldStyles.label} accessibilityLabel={label}>
        {label}
        {required ? <Text style={fieldStyles.required}> *</Text> : null}
      </Text>
      <TextInput
        style={[fieldStyles.input, errorMessage != null ? fieldStyles.inputError : null]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? label}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType}
        accessibilityLabel={label}
        accessibilityHint={required ? 'Required field' : undefined}
      />
      {errorMessage != null ? (
        <Text
          style={fieldStyles.errorText}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
    marginBottom: 6,
  },
  required: {
    color: colors.destructive,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: colors.foreground,
  },
  inputError: {
    borderColor: colors.destructive,
  },
  errorText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: colors.destructive,
    marginTop: 4,
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Full-screen modal handling the credential document upload flow.
 * Rendered by CHWProfileScreen when the user taps "Upload credential".
 */
export function CredentialUploadModal({
  visible,
  onClose,
  onUploaded,
}: CredentialUploadModalProps): React.JSX.Element {
  const [step, setStep] = useState<UploadStep>('pick');
  const [pickedDocument, setPickedDocument] = useState<PickedDocument | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const submitCredential = useSubmitCredential();
  const patchCredentialDocument = usePatchCredentialDocument();

  // ── Reset state when modal closes ─────────────────────────────────────────

  const handleClose = useCallback(() => {
    setStep('pick');
    setPickedDocument(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setErrorMessage(null);
    onClose();
  }, [onClose]);

  // ── Document picker ───────────────────────────────────────────────────────

  const handlePickDocument = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/jpeg', 'image/png'],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled) return;

      const asset = result.assets[0];
      if (asset == null) return;

      const mimeType = asset.mimeType ?? '';
      const sizeBytes = asset.size ?? 0;

      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        setErrorMessage(`Only ${ALLOWED_EXTENSIONS_DISPLAY} files are accepted.`);
        return;
      }

      if (sizeBytes > MAX_FILE_BYTES) {
        setErrorMessage(`File exceeds the 10 MB size limit (${formatFileSize(sizeBytes)}).`);
        return;
      }

      setErrorMessage(null);
      setPickedDocument({
        uri: asset.uri,
        displayName: asset.name,
        mimeType,
        sizeBytes,
      });
      setStep('form');
    } catch {
      // Do not surface internal picker errors to telemetry (could include
      // file system paths). Generalise to a friendly message.
      setErrorMessage('Unable to open the document picker. Please try again.');
    }
  }, []);

  // ── Form validation ───────────────────────────────────────────────────────

  function validateForm(): boolean {
    const errors: Partial<Record<keyof FormState, string>> = {};

    if (form.programName.trim().length === 0) {
      errors.programName = 'Programme name is required.';
    }
    if (form.institutionName.trim().length === 0) {
      errors.institutionName = 'Institution name is required.';
    }
    if (
      form.expiryDate.trim().length > 0 &&
      !isValidDateString(form.expiryDate.trim())
    ) {
      errors.expiryDate = 'Use YYYY-MM-DD format (e.g. 2027-06-30).';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!validateForm()) return;
    if (pickedDocument == null) return;

    setStep('uploading');
    setErrorMessage(null);

    try {
      // 1. Create the credential validation record first to obtain an ID.
      const credentialPayload: SubmitCredentialPayload = {
        programName: form.programName.trim(),
        institutionName: form.institutionName.trim(),
        certificateNumber:
          form.certificateNumber.trim().length > 0
            ? form.certificateNumber.trim()
            : undefined,
        graduationDate: undefined,
      };

      const newCredential = await submitCredential.mutateAsync(credentialPayload);

      // 2. Upload the file to S3 using a presigned PUT URL.
      //    No file name or S3 key is logged — HIPAA compliance.
      const s3Key = await uploadFile(
        {
          uri: pickedDocument.uri,
          name: pickedDocument.displayName,
          type: pickedDocument.mimeType,
          sizeBytes: pickedDocument.sizeBytes,
        },
        'credential',
      );

      // 3. Attach the S3 key (and optional expiry) to the credential record.
      //    This PATCH is currently stubbed pending the backend endpoint landing.
      //    See TODO in usePatchCredentialDocument.
      await patchCredentialDocument.mutateAsync({
        credentialId: newCredential.id,
        payload: {
          documentS3Key: s3Key,
          expiryDate:
            form.expiryDate.trim().length > 0 ? form.expiryDate.trim() : undefined,
        },
      });

      setStep('success');
      onUploaded?.();
    } catch {
      // Generic error — do not expose internal detail strings (may contain
      // file paths or S3 URLs) to the displayed message or to telemetry.
      setErrorMessage(
        'Upload failed. Please check your connection and try again.',
      );
      setStep('error');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedDocument, form, submitCredential, patchCredentialDocument, onUploaded]);

  // ── Render ────────────────────────────────────────────────────────────────

  // Web fallback — document upload is native-only for now.
  if (Platform.OS === 'web') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleClose}
      >
        <SafeAreaView style={modalStyles.safe} edges={['top', 'bottom']}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.headerTitle}>Upload Credential</Text>
            <TouchableOpacity
              onPress={handleClose}
              style={modalStyles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close upload modal"
            >
              <X size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <View style={modalStyles.webFallback}>
            <FileText size={48} color={colors.mutedForeground} />
            <Text style={modalStyles.webFallbackTitle}>Mobile app required</Text>
            <Text style={modalStyles.webFallbackBody}>
              Credential document uploads must be done from the iOS or Android app.
              Please open the Compass CHW app on your phone to upload this document.
            </Text>
          </View>
        </SafeAreaView>
      </Modal>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView style={modalStyles.safe} edges={['top', 'bottom']}>
        {/* ── Header ── */}
        <View style={modalStyles.header}>
          <Text style={modalStyles.headerTitle}>Upload Credential</Text>
          <TouchableOpacity
            onPress={handleClose}
            style={modalStyles.closeButton}
            accessibilityRole="button"
            accessibilityLabel="Close upload modal"
          >
            <X size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {/* ── Step: Pick ── */}
        {step === 'pick' ? (
          <ScrollView
            style={modalStyles.scroll}
            contentContainerStyle={modalStyles.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={modalStyles.stepHeading}>Select document</Text>
            <Text style={modalStyles.stepSubheading}>
              Accepted formats: {ALLOWED_EXTENSIONS_DISPLAY}. Max size: 10 MB.
            </Text>

            {errorMessage != null ? (
              <View style={modalStyles.errorBanner} accessibilityRole="alert">
                <AlertCircle size={16} color={colors.destructive} />
                <Text style={modalStyles.errorBannerText}>{errorMessage}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={modalStyles.pickDocumentButton}
              onPress={() => void handlePickDocument()}
              accessibilityRole="button"
              accessibilityLabel="Choose a document from your device"
            >
              <FileText size={32} color={colors.primary} />
              <Text style={modalStyles.pickDocumentLabel}>Tap to choose a file</Text>
              <Text style={modalStyles.pickDocumentHint}>
                {ALLOWED_EXTENSIONS_DISPLAY} · up to 10 MB
              </Text>
            </TouchableOpacity>
          </ScrollView>
        ) : null}

        {/* ── Step: Form ── */}
        {step === 'form' ? (
          <ScrollView
            style={modalStyles.scroll}
            contentContainerStyle={modalStyles.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={modalStyles.stepHeading}>Credential details</Text>

            {/* Selected file preview */}
            {pickedDocument != null ? (
              <View style={modalStyles.filePreview}>
                <FileText size={20} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.filePreviewName} numberOfLines={1}>
                    {pickedDocument.displayName}
                  </Text>
                  <Text style={modalStyles.filePreviewMeta}>
                    {formatFileSize(pickedDocument.sizeBytes)}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    setPickedDocument(null);
                    setStep('pick');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Remove selected file and go back"
                >
                  <X size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
            ) : null}

            {/* Credential type selector */}
            <View style={fieldStyles.container}>
              <Text style={fieldStyles.label}>
                Credential type <Text style={fieldStyles.required}>*</Text>
              </Text>
              <View style={modalStyles.typeRow}>
                {CREDENTIAL_TYPE_OPTIONS.map(({ value, label }) => {
                  const isSelected = form.credentialType === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      style={[
                        modalStyles.typePill,
                        isSelected
                          ? modalStyles.typePillSelected
                          : modalStyles.typePillUnselected,
                      ]}
                      onPress={() =>
                        setForm((prev) => ({ ...prev, credentialType: value }))
                      }
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={label}
                    >
                      <Text
                        style={[
                          modalStyles.typePillText,
                          { color: isSelected ? colors.primary : colors.mutedForeground },
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <Field
              label="Programme name"
              value={form.programName}
              onChangeText={(text) =>
                setForm((prev) => ({ ...prev, programName: text }))
              }
              placeholder={
                CREDENTIAL_TYPE_OPTIONS.find(
                  (opt) => opt.value === form.credentialType,
                )?.placeholder ?? 'e.g. CHW Certification'
              }
              errorMessage={fieldErrors.programName}
              required
            />

            <Field
              label="Institution name"
              value={form.institutionName}
              onChangeText={(text) =>
                setForm((prev) => ({ ...prev, institutionName: text }))
              }
              placeholder="e.g. CalOptima, LA County DHS"
              errorMessage={fieldErrors.institutionName}
              required
            />

            <Field
              label="Certificate or licence number"
              value={form.certificateNumber}
              onChangeText={(text) =>
                setForm((prev) => ({ ...prev, certificateNumber: text }))
              }
              placeholder="Optional"
            />

            <Field
              label="Expiry date (YYYY-MM-DD)"
              value={form.expiryDate}
              onChangeText={(text) =>
                setForm((prev) => ({ ...prev, expiryDate: text }))
              }
              placeholder="e.g. 2027-06-30 (optional)"
              errorMessage={fieldErrors.expiryDate}
            />

            <TouchableOpacity
              style={modalStyles.submitButton}
              onPress={() => void handleSubmit()}
              accessibilityRole="button"
              accessibilityLabel="Submit credential upload"
            >
              <Upload size={18} color="#FFFFFF" />
              <Text style={modalStyles.submitButtonText}>Upload credential</Text>
              <ChevronRight size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </ScrollView>
        ) : null}

        {/* ── Step: Uploading ── */}
        {step === 'uploading' ? (
          <View style={modalStyles.centeredState}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={modalStyles.centeredStateTitle}>Uploading…</Text>
            <Text style={modalStyles.centeredStateBody}>
              Securely transmitting your document. Please keep the app open.
            </Text>
          </View>
        ) : null}

        {/* ── Step: Success ── */}
        {step === 'success' ? (
          <View style={modalStyles.centeredState}>
            <CheckCircle2 size={64} color={colors.secondary} />
            <Text style={modalStyles.centeredStateTitle}>Submitted for review</Text>
            <Text style={modalStyles.centeredStateBody}>
              Your credential has been received and will be reviewed within 48 hours.
              You'll see it listed as "Pending Review" in your profile.
            </Text>
            <TouchableOpacity
              style={modalStyles.doneButton}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close and return to profile"
            >
              <Text style={modalStyles.doneButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* ── Step: Error ── */}
        {step === 'error' ? (
          <View style={modalStyles.centeredState}>
            <AlertCircle size={64} color={colors.destructive} />
            <Text style={modalStyles.centeredStateTitle}>Upload failed</Text>
            {errorMessage != null ? (
              <Text
                style={modalStyles.centeredStateBody}
                accessibilityRole="alert"
              >
                {errorMessage}
              </Text>
            ) : null}
            <TouchableOpacity
              style={modalStyles.retryButton}
              onPress={() => setStep('form')}
              accessibilityRole="button"
              accessibilityLabel="Retry upload"
            >
              <Text style={modalStyles.retryButtonText}>Try again</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={modalStyles.cancelButton}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel and close"
            >
              <Text style={modalStyles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const modalStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: colors.foreground,
  },
  closeButton: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: colors.muted,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingBottom: 48,
  },
  stepHeading: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    lineHeight: 28,
    color: colors.foreground,
    marginBottom: 6,
  },
  stepSubheading: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    marginBottom: 24,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.destructive + '12',
    borderWidth: 1,
    borderColor: colors.destructive + '40',
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
  },
  errorBannerText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: colors.destructive,
    lineHeight: 20,
  },
  pickDocumentButton: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.primary + '40',
    borderStyle: 'dashed',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  pickDocumentLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: colors.primary,
  },
  pickDocumentHint: {
    ...typography.label,
    color: colors.mutedForeground,
    textTransform: 'uppercase',
  },
  filePreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.primary + '10',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.primary + '30',
    padding: 14,
    marginBottom: 20,
  },
  filePreviewName: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: colors.foreground,
  },
  filePreviewMeta: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  typeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  typePill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 100,
    borderWidth: 1,
  },
  typePillSelected: {
    backgroundColor: colors.primary + '18',
    borderColor: colors.primary,
  },
  typePillUnselected: {
    backgroundColor: '#FFFFFF',
    borderColor: colors.border,
  },
  typePillText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    lineHeight: 18,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    marginTop: 8,
  },
  submitButtonText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#FFFFFF',
    flex: 1,
    textAlign: 'center',
  },
  centeredState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  centeredStateTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    lineHeight: 28,
    color: colors.foreground,
    textAlign: 'center',
  },
  centeredStateBody: {
    ...typography.bodyMd,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 24,
  },
  doneButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 40,
    marginTop: 8,
  },
  doneButtonText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#FFFFFF',
  },
  retryButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 40,
    marginTop: 8,
  },
  retryButtonText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#FFFFFF',
  },
  cancelButton: {
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 40,
  },
  cancelButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: colors.mutedForeground,
  },
  webFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  webFallbackTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    color: colors.foreground,
    textAlign: 'center',
  },
  webFallbackBody: {
    ...typography.bodyMd,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 24,
  },
});
