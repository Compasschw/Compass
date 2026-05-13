/**
 * MemberDocumentsScreen — personal document folder for the member.
 *
 * Layout:
 *   - PageHeader: "My Documents"
 *   - 4-column grid of document cards (uploaded and pending)
 *   - Right rail: "What does [CHW] need next?" upload prompt card
 *
 * Note: Document upload is mocked with an Alert placeholder. Wire to the
 * presigned-URL upload flow when a member-facing /member/documents endpoint
 * ships. The "Maria needs this" upload card prompts for the next required
 * document from the active journey step.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
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
  CheckCircle2,
  Clock,
  FileText,
  Upload,
  XCircle,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useMemberProfile,
  useMemberJourneys,
} from '../../hooks/useApiQueries';
import {
  AppShell,
  PageHeader,
  Card,
  Pill,
  RightRail,
} from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentStatus = 'uploaded' | 'pending' | 'rejected';

interface MemberDocument {
  id: string;
  name: string;
  status: DocumentStatus;
  uploadedAt: string | null;
  /** Which journey step requires this document. Null = general. */
  requiredBy: string | null;
  /** Emoji icon representing the document category. */
  icon: string;
}

// ─── Mock documents (replace with real endpoint when available) ───────────────

const MOCK_DOCUMENTS: MemberDocument[] = [
  {
    id: 'doc-1',
    name: 'Photo ID',
    status: 'uploaded',
    uploadedAt: '2026-04-15T10:00:00Z',
    requiredBy: null,
    icon: '🪪',
  },
  {
    id: 'doc-2',
    name: 'Proof of Address',
    status: 'uploaded',
    uploadedAt: '2026-04-16T14:30:00Z',
    requiredBy: null,
    icon: '🏠',
  },
  {
    id: 'doc-3',
    name: 'Medi-Cal Card',
    status: 'pending',
    uploadedAt: null,
    requiredBy: 'Enrollment Step',
    icon: '💳',
  },
  {
    id: 'doc-4',
    name: 'Income Verification',
    status: 'rejected',
    uploadedAt: '2026-04-18T09:00:00Z',
    requiredBy: null,
    icon: '📄',
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusPillVariant(
  status: DocumentStatus,
): import('../../components/ui/Pill').PillVariant {
  switch (status) {
    case 'uploaded': return 'emerald';
    case 'pending': return 'amber';
    case 'rejected': return 'red';
    default: return 'gray';
  }
}

function statusLabel(status: DocumentStatus): string {
  switch (status) {
    case 'uploaded': return 'Uploaded';
    case 'pending': return 'Needed';
    case 'rejected': return 'Re-upload';
    default: return status;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface DocCardProps {
  doc: MemberDocument;
  onUpload: (doc: MemberDocument) => void;
  isUploadPlaceholder?: boolean;
}

function DocCard({ doc, onUpload, isUploadPlaceholder = false }: DocCardProps): React.JSX.Element {
  const isPending = doc.status === 'pending' || doc.status === 'rejected';
  const pillVariant = statusPillVariant(doc.status);

  return (
    <Card
      style={[
        dc.card,
        isPending && dc.cardPending,
        isUploadPlaceholder && dc.cardPlaceholder,
      ]}
    >
      {/* Icon */}
      <View style={[dc.iconCircle, isPending && dc.iconCirclePending]}>
        {isPending ? (
          <Upload size={20} color={isUploadPlaceholder ? tokens.primary : tokens.amber700} />
        ) : (
          <Text style={dc.iconEmoji}>{doc.icon}</Text>
        )}
      </View>

      {/* Name */}
      <Text style={[dc.name, isPending && dc.namePending]} numberOfLines={2}>
        {doc.name}
      </Text>

      {/* Status pill */}
      <Pill variant={pillVariant} size="sm">{statusLabel(doc.status)}</Pill>

      {/* Date */}
      {doc.uploadedAt !== null && (
        <Text style={dc.date}>{formatDate(doc.uploadedAt)}</Text>
      )}

      {/* Upload / re-upload button */}
      {isPending && (
        <Pressable
          onPress={() => onUpload(doc)}
          style={({ pressed }) => [dc.uploadBtn, pressed && { opacity: 0.75 }]}
          accessibilityRole="button"
          accessibilityLabel={`Upload ${doc.name}`}
        >
          <Upload size={12} color="#FFFFFF" />
          <Text style={dc.uploadBtnText}>
            {doc.status === 'rejected' ? 'Re-upload' : 'Upload'}
          </Text>
        </Pressable>
      )}
    </Card>
  );
}

const dc = StyleSheet.create({
  card: {
    // p-4 = 16px from mockup; fixed-width thumbnail card matching mock grid
    padding: 16,
    gap: 8,
    alignItems: 'flex-start',
    flex: 1,
    // min 160px so cards look like tiles, not tiny chips
    minWidth: 160,
    maxWidth: 220,
  } as ViewStyle,
  cardPending: {
    borderColor: '#FDE68A',
    backgroundColor: '#FFFBEB',
  } as ViewStyle,
  cardPlaceholder: {
    borderStyle: 'dashed',
    borderWidth: 2,
    borderColor: '#A7F3D0',
    backgroundColor: `#D1FAE5` + '20',
  } as ViewStyle,
  iconCircle: {
    // doc-thumb: w-full h-120 from mockup → use fixed 48px icon box
    width: '100%' as unknown as number,
    height: 96,
    borderRadius: 12,
    backgroundColor: tokens.gray100,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  iconCirclePending: {
    backgroundColor: '#FFFBEB',
  } as ViewStyle,
  iconEmoji: {
    // text-5xl ≈ 36px from mockup doc thumbnail
    fontSize: 36,
  } as TextStyle,
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    lineHeight: 20,
  } as TextStyle,
  namePending: {
    color: '#B45309',
  } as TextStyle,
  date: {
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    // bg-emerald-600 from mockup
    backgroundColor: '#059669',
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
  const memberId = profileQuery.data?.id ?? '';
  const journeysQuery = useMemberJourneys(memberId);

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  // Derive the next required document from the active journey step.
  const nextRequiredDoc = useMemo(() => {
    const journeys = journeysQuery.data ?? [];
    const active =
      journeys.find((j) => j.status === 'active') ?? journeys[0] ?? null;
    const step =
      active?.currentStep ??
      active?.steps.find((s) => s.status === 'in_progress' || s.status === 'upcoming') ??
      null;
    return step?.requiredDocuments[0] ?? null;
  }, [journeysQuery.data]);

  const [localDocs, setLocalDocs] = useState<MemberDocument[]>(MOCK_DOCUMENTS);

  const handleUpload = useCallback((doc: MemberDocument) => {
    Alert.alert(
      `Upload ${doc.name}`,
      "Choose how you'd like to upload this document.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Take Photo',
          onPress: () => {
            // TODO: wire to ImagePicker when member-side upload flow ships.
            setLocalDocs((prev) =>
              prev.map((d) =>
                d.id === doc.id
                  ? { ...d, status: 'uploaded' as DocumentStatus, uploadedAt: new Date().toISOString() }
                  : d,
              ),
            );
            Alert.alert('Uploaded', `${doc.name} has been uploaded successfully.`);
          },
        },
        {
          text: 'Choose from Library',
          onPress: () => {
            setLocalDocs((prev) =>
              prev.map((d) =>
                d.id === doc.id
                  ? { ...d, status: 'uploaded' as DocumentStatus, uploadedAt: new Date().toISOString() }
                  : d,
              ),
            );
            Alert.alert('Uploaded', `${doc.name} has been uploaded successfully.`);
          },
        },
      ],
    );
  }, []);

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  const uploadedCount = localDocs.filter((d) => d.status === 'uploaded').length;
  const pendingCount = localDocs.filter((d) => d.status !== 'uploaded').length;

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
            subtitle={`${uploadedCount} uploaded · ${pendingCount} needed`}
          />

          <View style={styles.body}>
            {/* Main column — document grid */}
            <View style={styles.mainCol}>
              <Text style={styles.sectionLabel}>YOUR DOCUMENTS</Text>
              <View style={styles.docGrid}>
                {localDocs.map((doc) => (
                  <DocCard key={doc.id} doc={doc} onUpload={handleUpload} />
                ))}

                {/* Placeholder upload card if there's a next required doc */}
                {nextRequiredDoc !== null && (
                  <DocCard
                    doc={{
                      id: 'placeholder',
                      name: nextRequiredDoc,
                      status: 'pending',
                      uploadedAt: null,
                      requiredBy: 'Your CHW needs this',
                      icon: '📄',
                    }}
                    onUpload={(d) => handleUpload(d)}
                    isUploadPlaceholder
                  />
                )}
              </View>
            </View>

            {/* Right rail */}
            <RightRail width={260}>
              <Card style={styles.railCard}>
                <View style={styles.railHeader}>
                  <FileText size={16} color={tokens.primary} />
                  <Text style={styles.railTitle}>What does your CHW need?</Text>
                </View>
                <Text style={styles.railBody}>
                  Your CHW may request documents as part of your care journey.
                  Keep your uploads current to avoid delays in services.
                </Text>
                <View style={styles.railList}>
                  {localDocs
                    .filter((d) => d.status !== 'uploaded')
                    .map((d) => (
                      <View key={d.id} style={styles.railDocRow}>
                        <XCircle size={13} color={tokens.amber700} />
                        <Text style={styles.railDocName}>{d.name}</Text>
                      </View>
                    ))}
                  {localDocs.filter((d) => d.status === 'uploaded').map((d) => (
                    <View key={d.id} style={styles.railDocRow}>
                      <CheckCircle2 size={13} color={tokens.emerald700} />
                      <Text style={[styles.railDocName, { color: tokens.emerald700 }]}>
                        {d.name}
                      </Text>
                    </View>
                  ))}
                </View>
                {nextRequiredDoc !== null && (
                  <View style={styles.nextDocBanner}>
                    <Clock size={13} color={tokens.primary} />
                    <Text style={styles.nextDocText}>
                      Next needed: <Text style={{ fontWeight: '700' }}>{nextRequiredDoc}</Text>
                    </Text>
                  </View>
                )}
              </Card>
            </RightRail>
          </View>
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
    // p-8 = 32px from mockup
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 32,
    maxWidth: undefined as unknown as number,
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
    // gap-4 = 16px from mockup
    gap: 16,
  } as ViewStyle,
  railCard: {
    padding: 20,
    gap: 12,
    // mock: bg-gradient-to-b from-amber-50/40 to-white
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
    color: tokens.textPrimary,
    flex: 1,
  } as TextStyle,
  nextDocBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: `${tokens.primary}10`,
    borderRadius: 8,
    padding: 10,
  } as ViewStyle,
  nextDocText: {
    fontSize: 12,
    color: tokens.primary,
    flex: 1,
  } as TextStyle,
});
