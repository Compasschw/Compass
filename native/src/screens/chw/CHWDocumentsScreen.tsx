/**
 * CHWDocumentsScreen — Member document storage table for CHWs.
 *
 * Displays all documents uploaded in the context of the CHW's sessions
 * (consent forms, assessments, care plans, referral letters) in a sortable
 * table. CHW can filter by type or member, and download/preview any doc.
 *
 * All data is mocked inline for v1 — the /chw/documents endpoint does not
 * exist yet. Replace with a real query hook once it ships.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  FileText,
  Download,
  Search,
  ClipboardList,
  FileBadge,
  FileSignature,
  FileScan,
  Filter,
  Eye,
  Trash2,
} from 'lucide-react-native';

import { AppShell, EmptyState, PageHeader, Card, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocType = 'all' | 'consent' | 'assessment' | 'care_plan' | 'referral' | 'other';

interface DocumentRecord {
  id: string;
  filename: string;
  docType: Exclude<DocType, 'all'>;
  memberName: string;
  memberId: string;
  sessionId?: string;
  uploadedAt: string;
  sizeKb: number;
  status: 'pending_review' | 'approved' | 'archived';
}

// ─── Mock data — TODO: replace with real hook ─────────────────────────────────

// TODO: replace with real hook — GET /chw/documents
const MOCK_DOCUMENTS: DocumentRecord[] = [
  {
    id: 'doc-001',
    filename: 'AI_Transcription_Consent_Rivera.pdf',
    docType: 'consent',
    memberName: 'Maria Rivera',
    memberId: 'mem-001',
    sessionId: 'sess-101',
    uploadedAt: '2026-05-08T14:22:00Z',
    sizeKb: 48,
    status: 'approved',
  },
  {
    id: 'doc-002',
    filename: 'SDOH_Assessment_Chen_2026-05-07.pdf',
    docType: 'assessment',
    memberName: 'David Chen',
    memberId: 'mem-002',
    sessionId: 'sess-102',
    uploadedAt: '2026-05-07T10:15:00Z',
    sizeKb: 134,
    status: 'approved',
  },
  {
    id: 'doc-003',
    filename: 'CarePlan_Johnson_Q2-2026.pdf',
    docType: 'care_plan',
    memberName: 'Tamika Johnson',
    memberId: 'mem-003',
    uploadedAt: '2026-05-06T09:00:00Z',
    sizeKb: 210,
    status: 'approved',
  },
  {
    id: 'doc-004',
    filename: 'Referral_MentalHealth_Rivera.pdf',
    docType: 'referral',
    memberName: 'Maria Rivera',
    memberId: 'mem-001',
    sessionId: 'sess-101',
    uploadedAt: '2026-05-05T16:40:00Z',
    sizeKb: 72,
    status: 'approved',
  },
  {
    id: 'doc-005',
    filename: 'Consent_MedicalBilling_Patel.pdf',
    docType: 'consent',
    memberName: 'Arjun Patel',
    memberId: 'mem-004',
    sessionId: 'sess-103',
    uploadedAt: '2026-05-04T11:20:00Z',
    sizeKb: 52,
    status: 'approved',
  },
  {
    id: 'doc-006',
    filename: 'SDOH_Assessment_Patel_Initial.pdf',
    docType: 'assessment',
    memberName: 'Arjun Patel',
    memberId: 'mem-004',
    sessionId: 'sess-103',
    uploadedAt: '2026-05-03T13:55:00Z',
    sizeKb: 156,
    status: 'pending_review',
  },
  {
    id: 'doc-007',
    filename: 'HousingReferral_Nguyen.pdf',
    docType: 'referral',
    memberName: 'Linh Nguyen',
    memberId: 'mem-005',
    uploadedAt: '2026-05-01T08:30:00Z',
    sizeKb: 88,
    status: 'approved',
  },
  {
    id: 'doc-008',
    filename: 'CarePlan_Chen_Quarterly.pdf',
    docType: 'care_plan',
    memberName: 'David Chen',
    memberId: 'mem-002',
    uploadedAt: '2026-04-28T15:10:00Z',
    sizeKb: 198,
    status: 'archived',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<DocType, string> = {
  all:        'All Types',
  consent:    'Consent',
  assessment: 'Assessment',
  care_plan:  'Care Plan',
  referral:   'Referral',
  other:      'Other',
};

const DOC_TYPE_PILL: Record<Exclude<DocType, 'all'>, 'blue' | 'purple' | 'emerald' | 'amber' | 'gray'> = {
  consent:    'blue',
  assessment: 'purple',
  care_plan:  'emerald',
  referral:   'amber',
  other:      'gray',
};

const STATUS_PILL: Record<DocumentRecord['status'], 'emerald' | 'amber' | 'gray'> = {
  approved:        'emerald',
  pending_review:  'amber',
  archived:        'gray',
};

const STATUS_LABEL: Record<DocumentRecord['status'], string> = {
  approved:       'Approved',
  pending_review: 'Pending Review',
  archived:       'Archived',
};

function DocTypeIcon({ docType, size = 16 }: { docType: Exclude<DocType, 'all'>; size?: number }): React.JSX.Element {
  const color = colors.textSecondary;
  switch (docType) {
    case 'consent':    return <FileSignature size={size} color={color} />;
    case 'assessment': return <ClipboardList  size={size} color={color} />;
    case 'care_plan':  return <FileBadge      size={size} color={color} />;
    case 'referral':   return <FileScan       size={size} color={color} />;
    default:           return <FileText       size={size} color={color} />;
  }
}

function formatBytes(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWDocumentsScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<DocType>('all');

  const filtered = useMemo(() => {
    const lq = query.toLowerCase();
    return MOCK_DOCUMENTS.filter((d) => {
      const typeMatch = activeType === 'all' || d.docType === activeType;
      const qMatch =
        query.length === 0 ||
        d.filename.toLowerCase().includes(lq) ||
        d.memberName.toLowerCase().includes(lq);
      return typeMatch && qMatch;
    });
  }, [query, activeType]);

  const pendingCount = MOCK_DOCUMENTS.filter((d) => d.status === 'pending_review').length;
  const docTypes = Object.keys(DOC_TYPE_LABELS) as DocType[];

  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const content = (
    <>
      <PageHeader
        title="Documents"
        subtitle={`${MOCK_DOCUMENTS.length} documents · ${pendingCount} pending review`}
        right={
          <View style={styles.searchWrap}>
            <Search size={14} color={colors.textSecondary} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search documents or members…"
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={setQuery}
              accessibilityLabel="Search documents"
            />
          </View>
        }
      />

      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
      >
        {docTypes.map((type) => (
          <TouchableOpacity
            key={type}
            onPress={() => setActiveType(type)}
            style={[styles.filterChip, activeType === type && styles.filterChipActive]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${DOC_TYPE_LABELS[type]}`}
            accessibilityState={{ selected: activeType === type }}
          >
            <Filter size={10} color={activeType === type ? colors.cardBg : colors.textSecondary} />
            <Text style={[styles.filterChipText, activeType === type && styles.filterChipTextActive]}>
              {DOC_TYPE_LABELS[type]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Body row */}
      <View style={styles.bodyRow}>
        <View style={styles.tableWrap}>
          {/* Table header */}
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.colHeader, styles.colFile]}>File</Text>
            <Text style={[styles.colHeader, styles.colMember]}>Member</Text>
            <Text style={[styles.colHeader, styles.colType]}>Type</Text>
            <Text style={[styles.colHeader, styles.colDate]}>Uploaded</Text>
            <Text style={[styles.colHeader, styles.colSize]}>Size</Text>
            <Text style={[styles.colHeader, styles.colStatus]}>Status</Text>
            <Text style={[styles.colHeader, styles.colAction]}>{' '}</Text>
          </View>

          {/* Table body */}
          {filtered.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No documents found"
              body="Try a different search term or document type filter."
            />
          ) : (
            filtered.map((doc, idx) => (
              <Card
                key={doc.id}
                style={[styles.tableRowCard, idx % 2 === 1 && styles.tableRowAlt]}
              >
                <View style={styles.tableRow}>
                  {/* File */}
                  <View style={[styles.colFile, styles.fileCell]}>
                    <View style={[styles.fileTypeBadge, { backgroundColor: doc.filename.endsWith('.pdf') ? '#7c3aed' : '#dc2626' }]}>
                      <Text style={styles.fileTypeBadgeText}>{doc.filename.endsWith('.pdf') ? 'PDF' : 'IMG'}</Text>
                    </View>
                    <View style={styles.fileCellText}>
                      <Text style={styles.filename} numberOfLines={1}>
                        {doc.filename}
                      </Text>
                      <Text style={styles.fileSubtitle} numberOfLines={1}>
                        {doc.docType.replace('_', ' ')} · {doc.memberId}
                      </Text>
                    </View>
                  </View>

                  {/* Member */}
                  <Text style={[styles.cellText, styles.colMember]} numberOfLines={1}>
                    {doc.memberName}
                  </Text>

                  {/* Type */}
                  <View style={styles.colType}>
                    <Pill variant={DOC_TYPE_PILL[doc.docType]} size="sm">
                      {DOC_TYPE_LABELS[doc.docType]}
                    </Pill>
                  </View>

                  {/* Date */}
                  <Text style={[styles.cellText, styles.colDate]}>
                    {formatDate(doc.uploadedAt)}
                  </Text>

                  {/* Size */}
                  <Text style={[styles.cellText, styles.colSize]}>
                    {formatBytes(doc.sizeKb)}
                  </Text>

                  {/* Status */}
                  <View style={styles.colStatus}>
                    <Pill variant={STATUS_PILL[doc.status]} size="sm">
                      {STATUS_LABEL[doc.status]}
                    </Pill>
                  </View>

                  {/* Actions */}
                  <View style={styles.colAction}>
                    <TouchableOpacity
                      accessible
                      accessibilityLabel={`Preview ${doc.filename}`}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      <Eye size={14} color={colors.textSecondary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessible
                      accessibilityLabel={`Download ${doc.filename}`}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      <Download size={14} color={colors.textSecondary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessible
                      accessibilityLabel={`Delete ${doc.filename}`}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      <Trash2 size={14} color={colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                </View>
              </Card>
            ))
          )}
        </View>

        {Platform.OS === 'web' && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Document Stats</Text>
              <StatTile
                icon={<FileText size={18} color={colors.blue700} />}
                iconBg={colors.blue100}
                label="Total Documents"
                value={MOCK_DOCUMENTS.length}
                style={styles.statTile}
              />
              <StatTile
                icon={<ClipboardList size={18} color={colors.amber700} />}
                iconBg={colors.amber100}
                label="Pending Review"
                value={pendingCount}
                deltaColor={pendingCount > 0 ? colors.amber700 : colors.emerald700}
                style={styles.statTile}
              />
              <StatTile
                icon={<FileBadge size={18} color={colors.emerald700} />}
                iconBg={colors.emerald100}
                label="Approved"
                value={MOCK_DOCUMENTS.filter((d) => d.status === 'approved').length}
                style={styles.statTile}
              />
            </Card>

            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Recent Activity</Text>
              <View style={styles.activityList}>
                {MOCK_DOCUMENTS.slice(0, 4).map((doc) => (
                  <View key={doc.id} style={styles.activityItem}>
                    <DocTypeIcon docType={doc.docType} size={12} />
                    <View style={styles.activityText}>
                      <Text style={styles.activityFilename} numberOfLines={1}>
                        {doc.filename}
                      </Text>
                      <Text style={styles.activityMember}>{doc.memberName}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </Card>
          </RightRail>
        )}
      </View>
    </>
  );

  if (Platform.OS !== 'web') {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView contentContainerStyle={styles.nativeScroll} showsVerticalScrollIndicator={false}>
          {content}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <AppShell
      role="chw"
      activeKey="documents"
      userBlock={{ initials: userInitials, name: userName ?? 'CHW', role: 'CHW' }}
    >
      {content}
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,

  nativeScroll: {
    padding: spacing.lg,
    flexGrow: 1,
  } as ViewStyle,

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    height: 36,
    gap: spacing.xs,
    minWidth: 260,
  } as ViewStyle,

  searchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    height: '100%',
    outlineStyle: 'none',
  } as unknown as TextStyle,

  chipRow: {
    marginBottom: spacing.lg,
    // Prevent the horizontal ScrollView from claiming any extra vertical
    // height in its column-direction parent. Without this, RN-Web's default
    // flex behaviour stretches the row to fill, and the chips inside (which
    // are flex items in the row) get stretched vertically into tall capsules.
    flexGrow: 0,
    flexShrink: 0,
  } as ViewStyle,

  chipRowContent: {
    flexDirection: 'row',
    // Cross-axis center keeps each chip at its natural content height
    // instead of inheriting the row's full height.
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md,
  } as ViewStyle,

  filterChip: {
    alignSelf: 'flex-start',
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  } as ViewStyle,

  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
  } as unknown as TextStyle,

  filterChipTextActive: {
    color: '#065f46',
  } as unknown as TextStyle,

  bodyRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    alignItems: 'flex-start',
  } as ViewStyle,

  tableWrap: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  tableHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: '#f9fafb',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  tableRowCard: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,

  tableRowAlt: {
    backgroundColor: '#fafafa',
  } as ViewStyle,

  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  colHeader: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  } as unknown as TextStyle,

  colFile:   { flex: 2.5 } as ViewStyle,
  colMember: { flex: 1.5 } as ViewStyle,
  colType:   { flex: 1   } as ViewStyle,
  colDate:   { flex: 1   } as ViewStyle,
  colSize:   { width: 60 } as ViewStyle,
  colStatus: { flex: 1.2 } as ViewStyle,
  colAction: { width: 72, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 } as ViewStyle,

  fileCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  fileTypeBadge: {
    width: 34,
    height: 42,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  fileTypeBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#ffffff',
  } as TextStyle,

  fileCellText: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  filename: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '600',
    lineHeight: 18,
  } as unknown as TextStyle,

  fileSubtitle: {
    fontSize: 11,
    color: colors.textSecondary,
  } as unknown as TextStyle,

  cellText: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  } as unknown as TextStyle,

  railCard: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  railTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  } as unknown as TextStyle,

  statTile: {
    padding: spacing.md,
  } as ViewStyle,

  activityList: {
    gap: spacing.sm,
  } as ViewStyle,

  activityItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
  } as ViewStyle,

  activityText: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  activityFilename: {
    fontSize: 11,
    color: colors.textPrimary,
    fontWeight: '500',
  } as unknown as TextStyle,

  activityMember: {
    fontSize: 10,
    color: colors.textSecondary,
  } as unknown as TextStyle,
});
