/**
 * MemberDocumentsScreen — personal document folder for the member.
 *
 * Layout:
 *   - PageHeader: "My Documents" with uploaded / needed counts
 *   - Document grid: one card per document type category (id, income, address, medical, other)
 *     - If a document of that type is uploaded → DocCard (with Download + Delete)
 *     - If not → UploadCard (Upload {type} button)
 *   - Right rail: checklist of needed vs uploaded categories
 *   - EmptyState when zero documents uploaded
 *
 * Upload flow (per category):
 *   web:    hidden <input type="file"> → useFileUpload hook
 *   native: expo-document-picker → useFileUpload hook
 *
 * Download: calls GET /documents/{id}/download-url then opens the presigned URL.
 * Delete:   calls DELETE /documents/{id} (soft-delete), invalidates query.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
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
  type ImageStyle,
} from 'react-native';
import {
  CheckCircle2,
  Download,
  FileText,
  IdCard,
  MapPin,
  Stethoscope,
  Trash2,
  Upload,
  Wallet,
  XCircle,
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
  Pill,
  PressableCard,
  RightRail,
} from '../../components/ui';
import { colors as tokens, numerals } from '../../theme/tokens';

// ─── Document category config ─────────────────────────────────────────────────

interface CategoryConfig {
  type: DocumentType;
  label: string;
  Icon: React.ComponentType<{ size: number; color: string; strokeWidth?: number; accessibilityLabel?: string }>;
}

const DOCUMENT_CATEGORIES: CategoryConfig[] = [
  { type: 'id',      label: 'Photo ID',            Icon: IdCard      },
  { type: 'income',  label: 'Income Verification', Icon: Wallet      },
  { type: 'address', label: 'Proof of Address',    Icon: MapPin      },
  { type: 'medical', label: 'Medical Documents',   Icon: Stethoscope },
  { type: 'other',   label: 'Other',               Icon: FileText    },
];

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
        <Download size={14} color={tokens.primary} />
      )}
    </Pressable>
  );
}

// ─── DocThumbnail — image preview or category icon ────────────────────────────

interface DocThumbnailProps {
  doc: MemberDocumentData;
  config: CategoryConfig;
  isImage: boolean;
}

/**
 * Renders a small preview inside the card's icon box.
 *
 * For image documents we fetch a short-lived presigned GET URL and render the
 * actual image (cover-fit, clipped to the box). For non-image documents (PDFs),
 * or if the image URL fails to load, we fall back to the category glyph so the
 * card never renders empty.
 *
 * The presigned URL is only requested for images (`enabled: isImage`) so PDF
 * cards don't make a needless network round-trip.
 */
function DocThumbnail({ doc, config, isImage }: DocThumbnailProps): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const thumbQuery = useMemberDocumentDownloadUrl(doc.id, { enabled: isImage && !failed });

  const thumbUrl = isImage && !failed ? thumbQuery.data?.downloadUrl : undefined;

  if (thumbUrl) {
    return (
      <View style={[dc.iconBox, dc.iconBoxImage]}>
        <Image
          source={{ uri: thumbUrl }}
          style={dc.thumbImage}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityLabel={`Preview of ${doc.filename}`}
        />
      </View>
    );
  }

  // Loading an image preview.
  if (isImage && !failed && thumbQuery.isFetching) {
    return (
      <View style={dc.iconBox}>
        <ActivityIndicator size="small" color={tokens.primary} />
      </View>
    );
  }

  // PDF / non-image, or image preview unavailable → category glyph.
  return (
    <View style={dc.iconBox}>
      <config.Icon
        size={28}
        color={tokens.primary}
        strokeWidth={1.5}
        accessibilityLabel={`${config.label} icon`}
      />
    </View>
  );
}

// ─── DocCard — uploaded document ─────────────────────────────────────────────

interface DocCardProps {
  doc: MemberDocumentData;
  config: CategoryConfig;
  memberId: string;
}

function DocCard({ doc, config, memberId }: DocCardProps): React.JSX.Element {
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

  const isImage = doc.contentType.startsWith('image/');

  return (
    <PressableCard style={dc.card}>
      {/* Type badge */}
      <View style={[dc.typeBadge, { backgroundColor: isImage ? '#7c3aed' : '#dc2626' }]}>
        <Text style={dc.typeBadgeText}>{isImage ? 'IMG' : 'PDF'}</Text>
      </View>

      {/* Image preview (for image docs) or category icon */}
      <DocThumbnail doc={doc} config={config} isImage={isImage} />

      {/* Filename */}
      <Text style={dc.filename} numberOfLines={2}>{doc.filename}</Text>

      {/* Status pill */}
      <Pill variant="emerald" size="sm">Uploaded</Pill>

      {/* Meta row — tabular numerals for date + size */}
      <View style={dc.metaRow}>
        <Text style={[dc.metaText, numerals.tabular as object]}>{formatDate(doc.uploadedAt)}</Text>
        <Text style={[dc.metaText, numerals.tabular as object]}>{formatBytes(doc.sizeBytes)}</Text>
      </View>

      {/* Actions */}
      <View style={dc.actionsRow}>
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
            <Trash2 size={14} color="#dc2626" />
          )}
        </Pressable>
      </View>
    </PressableCard>
  );
}

// ─── UploadCard — upload slot per document type ───────────────────────────────

interface UploadCardProps {
  config: CategoryConfig;
  memberId: string;
  /** True when a document of this type already exists (shows Replace label). */
  isReplace?: boolean;
  existingDoc?: MemberDocumentData;
}

function UploadCard({
  config,
  memberId,
  isReplace = false,
}: UploadCardProps): React.JSX.Element {
  // Web: hidden file input ref.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { upload, isUploading } = useFileUpload('member_document', {
    memberId,
    documentType: config.type,
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

  const label = isReplace ? `Replace ${config.label}` : `Upload ${config.label}`;

  return (
    <View style={dc.card}>
      {/* Icon area — dashed placeholder */}
      <View style={dc.iconBoxPlaceholder}>
        {isUploading ? (
          <ActivityIndicator size="large" color={tokens.primary} />
        ) : (
          <config.Icon
            size={28}
            color={tokens.textSecondary}
            strokeWidth={1.5}
            accessibilityLabel={`${config.label} icon`}
          />
        )}
      </View>

      <Text style={dc.name} numberOfLines={2}>{config.label}</Text>

      <Pill variant="amber" size="sm">Needed</Pill>

      <Pressable
        onPress={handlePress}
        disabled={isUploading}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [dc.uploadBtn, pressed && { opacity: 0.75 }]}
      >
        <Upload size={12} color="#FFFFFF" />
        <Text style={dc.uploadBtnText}>{isUploading ? 'Uploading…' : label}</Text>
      </Pressable>

      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/heic,image/*"
          style={{ display: 'none' }}
          onChange={handleWebFileChange}
          aria-hidden="true"
        />
      )}
    </View>
  );
}

// ─── Shared card styles ───────────────────────────────────────────────────────

const dc = StyleSheet.create({
  card: {
    padding: 16,
    gap: 8,
    alignItems: 'flex-start',
    minWidth: 160,
    maxWidth: 220,
    flex: 1,
    backgroundColor: tokens.cardBg ?? '#ffffff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: tokens.cardBorder ?? '#e5e7eb',
  } as ViewStyle,

  typeBadge: {
    position: 'absolute' as const,
    top: 8,
    right: 8,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  } as ViewStyle,

  typeBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#ffffff',
  } as TextStyle,

  iconBox: {
    width: '100%' as unknown as number,
    height: 80,
    borderRadius: 12,
    backgroundColor: tokens.emerald100,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  // When showing an image preview: clip the photo to the rounded box and drop
  // the emerald tint so it doesn't bleed at the edges.
  iconBoxImage: {
    overflow: 'hidden',
    backgroundColor: tokens.gray100,
  } as ViewStyle,

  thumbImage: {
    width: '100%' as unknown as number,
    height: '100%' as unknown as number,
    borderRadius: 12,
  } as ImageStyle,

  iconBoxPlaceholder: {
    width: '100%' as unknown as number,
    height: 80,
    borderRadius: 12,
    borderStyle: 'dashed',
    borderWidth: 2,
    borderColor: tokens.cardBorder ?? '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.gray100,
  } as ViewStyle,

  filename: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textPrimary ?? '#111827',
    lineHeight: 18,
  } as TextStyle,

  name: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary ?? '#374151',
    lineHeight: 18,
  } as TextStyle,

  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%' as unknown as number,
  } as ViewStyle,

  metaText: {
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,

  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  } as ViewStyle,

  actionBtn: {
    padding: 4,
  } as ViewStyle,

  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: tokens.primary,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    marginTop: 4,
    width: '100%' as unknown as number,
    justifyContent: 'center',
  } as ViewStyle,

  uploadBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberDocumentsScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const profileQuery = useMemberProfile();
  const memberId = profileQuery.data?.userId ?? profileQuery.data?.id ?? '';

  const documentsQuery = useMemberDocuments(memberId);
  const docs = documentsQuery.data?.items ?? [];

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  // Build a map: documentType → first active document of that type.
  const docsByType = useMemo<Record<string, MemberDocumentData>>(() => {
    const map: Record<string, MemberDocumentData> = {};
    for (const doc of docs) {
      if (!map[doc.documentType]) {
        map[doc.documentType] = doc;
      }
    }
    return map;
  }, [docs]);

  const uploadedCount = Object.keys(docsByType).length;
  const neededCount = DOCUMENT_CATEGORIES.length - uploadedCount;

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  const isLoading = profileQuery.isLoading || documentsQuery.isLoading;
  const hasDocuments = docs.length > 0;

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
            subtitle={
              isLoading
                ? 'Loading…'
                : `${uploadedCount} uploaded · ${neededCount} needed`
            }
          />

          {isLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color={tokens.primary} />
            </View>
          ) : (
            <View style={styles.body}>
              {/* Main column */}
              <View style={styles.mainCol}>
                <Text style={styles.sectionLabel}>YOUR DOCUMENTS</Text>

                {!hasDocuments ? (
                  <EmptyState
                    icon={FileText}
                    title="No documents uploaded yet"
                    body="Upload ID, income proof, and other documents your CHW requests."
                    style={styles.emptyState}
                  />
                ) : null}

                <View style={styles.docGrid}>
                  {DOCUMENT_CATEGORIES.map((config) => {
                    const existing = docsByType[config.type];
                    if (existing) {
                      return (
                        <DocCard
                          key={config.type}
                          doc={existing}
                          config={config}
                          memberId={memberId}
                        />
                      );
                    }
                    return (
                      <UploadCard
                        key={config.type}
                        config={config}
                        memberId={memberId}
                      />
                    );
                  })}
                </View>
              </View>

              {/* Right rail */}
              <RightRail width={260}>
                <Card style={styles.railCard}>
                  <View style={styles.railHeader}>
                    <FileText size={16} color={tokens.primary} />
                    <Text style={styles.railTitle}>Document Checklist</Text>
                  </View>
                  <Text style={styles.railBody}>
                    Keep your documents current to avoid delays in services.
                  </Text>
                  <View style={styles.railList}>
                    {DOCUMENT_CATEGORIES.map((config) => {
                      const uploaded = !!docsByType[config.type];
                      return (
                        <View key={config.type} style={styles.railDocRow}>
                          {uploaded ? (
                            <CheckCircle2 size={13} color={tokens.emerald700} />
                          ) : (
                            <XCircle size={13} color={tokens.amber700} />
                          )}
                          <Text
                            style={[
                              styles.railDocName,
                              uploaded && { color: tokens.emerald700 },
                            ]}
                          >
                            {config.label}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </Card>
              </RightRail>
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
    alignSelf: 'center',
  } as ViewStyle,
  body: {
    flexDirection: 'row',
    gap: 20,
    alignItems: 'flex-start',
  } as ViewStyle,
  mainCol: {
    flex: 1,
    minWidth: 0,
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
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 16,
  } as TextStyle,
  docGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  } as ViewStyle,
  railCard: {
    padding: 20,
    gap: 12,
    backgroundColor: '#FFFBEB',
  } as ViewStyle,
  railHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  railTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
    lineHeight: 20,
  } as TextStyle,
  railBody: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 20,
  } as TextStyle,
  railList: {
    gap: 8,
  } as ViewStyle,
  railDocRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  railDocName: {
    fontSize: 12,
    color: tokens.textPrimary ?? '#111827',
    flex: 1,
  } as TextStyle,
});
