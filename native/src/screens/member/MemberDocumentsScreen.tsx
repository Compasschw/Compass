/**
 * MemberDocumentsScreen — personal document folder for the member.
 *
 * QA batch #7 Part 19 (2026-07-14): replaced the five per-category upload
 * cards (Photo ID / Income / Address / Medical / Other) with a single
 * "Upload Documents" card. An optional lightweight document-type picker
 * (id / income / address / other — **no medical**, per Part 6's HIPAA
 * minimum-necessary rationale) defaults to `other` so the backend
 * `document_type` field stays populated and the CHW-side repository
 * filters (CHWDocumentsScreen) keep working unchanged. This absorbs Part
 * 6's member-side "remove the Medical upload row" change.
 *
 * Layout:
 *   - PageHeader: "My Documents" with an "N uploaded" count (no more
 *     "M needed" — meaningless without required categories)
 *   - Upload Documents card: guidance copy (carried over from the old right
 *     rail, which is now removed entirely) + type picker + upload button
 *   - Uploaded-documents list: every document the member has uploaded,
 *     newest first (name, type, date, size, download, delete) — a row
 *     list rather than the old per-category grid, since there is no longer
 *     a fixed set of category slots to lay out.
 *
 * A pre-existing document of type 'medical' (uploaded before this change)
 * still renders normally in the list — DOC_TYPE_ICON/DOC_TYPE_LABEL below
 * intentionally keep a 'medical' entry for that grandfathering, even though
 * the type picker no longer offers it as an upload option.
 *
 * Upload flow: web hidden <input type="file"> / expo-document-picker,
 * both via the shared useFileUpload hook.
 * Download: calls GET /documents/{id}/download-url then opens the presigned URL.
 * Delete:   calls DELETE /documents/{id} (soft-delete), invalidates query.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  Download,
  FileText,
  IdCard,
  MapPin,
  Stethoscope,
  Trash2,
  Upload,
  Wallet,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useMemberProfile,
  useMemberDocuments,
  useMemberDocumentDelete,
  useMemberDocumentDownloadUrl,
  type MemberDocumentData,
} from '../../hooks/useApiQueries';
import {
  useFileUpload,
  type DocumentType,
} from '../../hooks/useFileUpload';
import {
  AppShell,
  Card,
  EmptyState,
  PageHeader,
} from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Document type config ──────────────────────────────────────────────────────

/**
 * Options offered by the upload type picker, in display order. Deliberately
 * excludes 'medical' (QA batch #7 Part 6 — Compass should not encourage
 * receiving confidential medical documents). Defaults to 'other'.
 */
const TYPE_PICKER_OPTIONS: ReadonlyArray<{ type: DocumentType; label: string }> = [
  { type: 'other',   label: 'Other' },
  { type: 'id',      label: 'Photo ID' },
  { type: 'income',  label: 'Income' },
  { type: 'address', label: 'Address' },
];

const DEFAULT_DOCUMENT_TYPE: DocumentType = 'other';

type DocIconComponent = React.ComponentType<{ size: number; color: string; strokeWidth?: number; accessibilityLabel?: string }>;

/**
 * Icon lookup covering all 5 backend document types (including 'medical')
 * so a pre-existing medical-typed row still renders a sensible icon in the
 * list — even though 'medical' is no longer an upload option.
 */
const DOC_TYPE_ICON: Record<string, DocIconComponent> = {
  id:      IdCard,
  income:  Wallet,
  address: MapPin,
  medical: Stethoscope,
  other:   FileText,
};

/** Label lookup mirroring DOC_TYPE_ICON — same grandfathering rationale. */
const DOC_TYPE_LABEL: Record<string, string> = {
  id:      'Photo ID',
  income:  'Income Verification',
  address: 'Proof of Address',
  medical: 'Medical Documents',
  other:   'Other',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showError(msg: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(msg);
  } else {
    Alert.alert('Error', msg);
  }
}

// ─── Download logic (opens presigned URL) ────────────────────────────────────

/**
 * DownloadButton — fetches a presigned download URL on demand and opens it.
 *
 * Renders a Download icon button. On press it calls the download-url endpoint,
 * then opens the returned URL.  A small activity spinner appears during fetch.
 */
function DownloadButton({ docId }: { docId: string }): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const downloadQuery = useMemberDocumentDownloadUrl(docId, { enabled });

  const handlePress = useCallback(() => {
    if (downloadQuery.isFetching) return;
    setEnabled(true);
  }, [downloadQuery.isFetching]);

  // When enabled and data arrives, open the URL then reset so the next press
  // fetches a fresh presigned URL (they expire in 15 min).
  React.useEffect(() => {
    if (!enabled || !downloadQuery.data) return;
    const url = downloadQuery.data.downloadUrl;
    void Linking.openURL(url).catch(() => {
      showError('Could not open the file. Please try again.');
    });
    setEnabled(false);
  }, [enabled, downloadQuery.data]);

  React.useEffect(() => {
    if (downloadQuery.isError) {
      showError('Could not generate a download link. Please try again.');
      setEnabled(false);
    }
  }, [downloadQuery.isError]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel="Download document"
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={({ pressed }) => [dc.actionBtn, pressed && { opacity: 0.6 }]}
    >
      {downloadQuery.isFetching ? (
        <ActivityIndicator size="small" color={tokens.primary} />
      ) : (
        <Download size={16} color={tokens.primary} />
      )}
    </Pressable>
  );
}

// ─── DocRow — a single row in the uploaded-documents list ────────────────────

interface DocRowProps {
  doc: MemberDocumentData;
  memberId: string;
}

function DocRow({ doc, memberId }: DocRowProps): React.JSX.Element {
  const deleteMutation = useMemberDocumentDelete(memberId);

  const handleDelete = useCallback(() => {
    const proceed = (): void => {
      deleteMutation.mutate(doc.id, {
        onError: () => showError('Could not delete the document. Please try again.'),
      });
    };

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm(`Delete "${doc.filename}"?`)) proceed();
    } else {
      Alert.alert('Delete document', `Delete "${doc.filename}"?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: proceed },
      ]);
    }
  }, [doc, deleteMutation]);

  const Icon = DOC_TYPE_ICON[doc.documentType] ?? FileText;
  const typeLabel = DOC_TYPE_LABEL[doc.documentType] ?? doc.documentType;

  return (
    <View style={dc.row}>
      <View style={dc.rowIconBox}>
        <Icon size={20} color={tokens.primary} strokeWidth={1.5} accessibilityLabel={`${typeLabel} icon`} />
      </View>
      <View style={dc.rowText}>
        <Text style={dc.rowFilename} numberOfLines={1}>{doc.filename}</Text>
        <Text style={dc.rowMeta} numberOfLines={1}>
          {typeLabel} · {formatDate(doc.uploadedAt)} · {formatBytes(doc.sizeBytes)}
        </Text>
      </View>
      <View style={dc.rowActions}>
        <DownloadButton docId={doc.id} />
        <Pressable
          onPress={handleDelete}
          disabled={deleteMutation.isPending}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${doc.filename}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={({ pressed }) => [dc.actionBtn, pressed && { opacity: 0.6 }]}
        >
          {deleteMutation.isPending ? (
            <ActivityIndicator size="small" color="#dc2626" />
          ) : (
            <Trash2 size={16} color="#dc2626" />
          )}
        </Pressable>
      </View>
    </View>
  );
}

// ─── UploadDocumentsCard — the single upload entry point ─────────────────────

interface UploadDocumentsCardProps {
  memberId: string;
}

function UploadDocumentsCard({ memberId }: UploadDocumentsCardProps): React.JSX.Element {
  const [selectedType, setSelectedType] = useState<DocumentType>(DEFAULT_DOCUMENT_TYPE);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { upload, isUploading } = useFileUpload('member_document', {
    memberId,
    documentType: selectedType,
    onError: (err) => showError(err.message),
  });

  const handlePress = useCallback(() => {
    if (isUploading) return;
    if (Platform.OS === 'web') {
      fileInputRef.current?.click();
    } else {
      void upload();
    }
  }, [isUploading, upload]);

  const handleWebFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      if (event.target) event.target.value = '';
      void upload(file);
    },
    [upload],
  );

  return (
    <Card style={dc.uploadCard}>
      <Text style={dc.uploadCardTitle}>Upload Documents</Text>
      <Text style={dc.uploadCardBody}>
        Upload ID, income proof, and other documents your CHW requests.
      </Text>

      <Text style={dc.typePickerLabel}>Document type (optional)</Text>
      <View style={dc.typePickerRow}>
        {TYPE_PICKER_OPTIONS.map((opt) => {
          const active = selectedType === opt.type;
          return (
            <Pressable
              key={opt.type}
              onPress={() => setSelectedType(opt.type)}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              aria-checked={active}
              accessibilityLabel={`Document type: ${opt.label}`}
              style={[dc.typePill, active && dc.typePillActive]}
            >
              <Text style={[dc.typePillText, active && dc.typePillTextActive]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        onPress={handlePress}
        disabled={isUploading}
        accessibilityRole="button"
        accessibilityLabel="Upload Documents"
        style={({ pressed }) => [dc.uploadBtn, pressed && { opacity: 0.85 }]}
      >
        <Upload size={14} color="#FFFFFF" />
        <Text style={dc.uploadBtnText}>{isUploading ? 'Uploading…' : 'Upload Documents'}</Text>
      </Pressable>

      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/heic,image/*"
          style={{ display: 'none' }}
          onChange={handleWebFileChange}
          aria-hidden="true"
        />
      )}
    </Card>
  );
}

// ─── Shared card / row styles ───────────────────────────────────────────────────

const dc = StyleSheet.create({
  uploadCard: {
    padding: 20,
    gap: 8,
    backgroundColor: tokens.cardBg ?? '#ffffff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: tokens.cardBorder ?? '#e5e7eb',
  } as ViewStyle,

  uploadCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: tokens.textPrimary ?? '#111827',
  } as TextStyle,

  uploadCardBody: {
    fontSize: 13,
    color: tokens.textSecondary ?? '#6B7280',
    lineHeight: 19,
    marginBottom: 4,
  } as TextStyle,

  typePickerLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.textMuted ?? '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 4,
  } as TextStyle,

  typePickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  } as ViewStyle,

  typePill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.cardBorder ?? '#e5e7eb',
    backgroundColor: tokens.gray100 ?? '#F3F4F6',
  } as ViewStyle,

  typePillActive: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  } as ViewStyle,

  typePillText: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textSecondary ?? '#374151',
  } as TextStyle,

  typePillTextActive: {
    color: '#FFFFFF',
  } as TextStyle,

  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: tokens.primary,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 6,
  } as ViewStyle,

  uploadBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,

  // ─── Uploaded-documents list rows ─────────────────────────────────────────
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: tokens.cardBg ?? '#ffffff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: tokens.cardBorder ?? '#e5e7eb',
  } as ViewStyle,

  rowIconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: tokens.emerald100,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  } as ViewStyle,

  rowFilename: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textPrimary ?? '#111827',
  } as TextStyle,

  rowMeta: {
    fontSize: 12,
    color: tokens.textMuted,
  } as TextStyle,

  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  } as ViewStyle,

  actionBtn: {
    padding: 6,
  } as ViewStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberDocumentsScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const profileQuery = useMemberProfile();
  const memberId = profileQuery.data?.userId ?? profileQuery.data?.id ?? '';

  const documentsQuery = useMemberDocuments(memberId);
  const docs = documentsQuery.data?.items ?? [];

  const sortedDocs = useMemo(
    () =>
      [...docs].sort(
        (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
      ),
    [docs],
  );

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  const isLoading = profileQuery.isLoading || documentsQuery.isLoading;
  const hasDocuments = sortedDocs.length > 0;

  return (
    <AppShell role="member" activeKey="documents" userBlock={shellUserBlock}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageWrap}>
          <PageHeader
            title="My Documents"
            subtitle={isLoading ? 'Loading…' : `${sortedDocs.length} uploaded`}
          />

          {isLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color={tokens.primary} />
            </View>
          ) : (
            <View style={styles.body}>
              <UploadDocumentsCard memberId={memberId} />

              {!hasDocuments ? (
                <EmptyState
                  icon={FileText}
                  title="No documents uploaded yet"
                  body="Upload ID, income proof, and other documents your CHW requests."
                  style={styles.emptyState}
                />
              ) : (
                <View style={styles.docList}>
                  {sortedDocs.map((doc) => (
                    <DocRow key={doc.id} doc={doc} memberId={memberId} />
                  ))}
                </View>
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  pageWrap: {
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 32,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  } as ViewStyle,
  body: {
    gap: 20,
  } as ViewStyle,
  loadingBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 200,
  } as ViewStyle,
  emptyState: {
    marginBottom: 16,
  } as ViewStyle,
  docList: {
    gap: 10,
  } as ViewStyle,
});
