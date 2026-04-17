/**
 * LandingScreen — Responsive replica of the CompassCHW Lovable landing page.
 *
 * Layout adapts at 1024 px (isDesktop):
 *   - Desktop: 2-column hero, 5-col services row, horizontal "How It Works" with
 *     connecting line, 2-col For CHWs, 2-col Mobile First, 4-col footer.
 *   - Mobile:  single column throughout, stacked buttons, 2-col service grid.
 *
 * Sections (top to bottom):
 *   1.  Sticky Navbar
 *   2.  Hero (toggle pill + 2-col on desktop)
 *   3.  Client Slider (trusted partners)
 *   4.  Services (cream bg, 5-col on desktop, stats bar)
 *   5.  How It Works (dark green, 3-step row on desktop)
 *   6.  For CHWs (cream bg, 2-col on desktop)
 *   7.  Mobile First (nude bg, 2-col on desktop)
 *   8.  CTA Section (neighborhood image + green overlay)
 *   9.  Footer (dark green, 4-col on desktop)
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  Animated,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import {
  Shield,
  CheckCircle,
  DollarSign,
  Heart,
  Users,
  Clock,
  Home,
  Pill,
  Apple,
  Brain,
  HeartPulse,
  Briefcase,
  ArrowRight,
  MapPin,
  Smartphone,
  Bus,
  UserPlus,
} from 'lucide-react-native';

import { colors } from '../theme/colors';
import { fonts } from '../theme/typography';
import { spacing, radii } from '../theme/spacing';
import type { AuthStackParamList } from '../navigation/AppNavigator';
import { InfiniteSlider } from '../components/InfiniteSlider';

// ─── Assets ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const compassIcon = require('../../assets/compass-icon.png') as number;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const heroChwImage = require('../../assets/hero-chw.jpg') as number;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const heroMemberImage = require('../../assets/hero-member.jpg') as number;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chwMobileImage = require('../../assets/chw-mobile.jpg') as number;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const neighborhoodImage = require('../../assets/neighborhood.jpg') as number;

// ─── Layout constants ─────────────────────────────────────────────────────────

/** Viewport width breakpoint above which the desktop 2-column layout is used. */
const DESKTOP_BREAKPOINT = 1024;

/** Maximum content width on desktop — mirrors Lovable's `max-w-7xl`. */
const MAX_CONTENT_WIDTH = 1280;

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = 'chw' | 'member';

type LandingNavProp = NativeStackNavigationProp<AuthStackParamList>;

// ─── Hero data ────────────────────────────────────────────────────────────────

interface TrustBadge {
  icon: React.FC<{ size: number; color: string }>;
  label: string;
}

interface HeroContent {
  headline: string;
  headlineAccent: string;
  descriptionPre: string;
  descriptionBold1: string;
  descriptionMid: string;
  descriptionBold2: string;
  descriptionPost: string;
  primaryButtonLabel: string;
  primaryButtonRoute: keyof AuthStackParamList;
  secondaryButtonLabel: string;
  heroImage: number;
  badges: TrustBadge[];
}

const CHW_HERO: HeroContent = {
  headline: 'Your CHW career, ',
  headlineAccent: 'on your terms.',
  descriptionPre: 'Compass connects ',
  descriptionBold1: 'Community Health Workers',
  descriptionMid:
    ' with Medi-Cal members who need services such as navigating housing, food, recovery, and healthcare — and ',
  descriptionBold2: 'pays you for your service',
  descriptionPost: ' through Medi-Cal.',
  primaryButtonLabel: 'Start Earning as a CHW',
  primaryButtonRoute: 'Login',
  secondaryButtonLabel: 'I Need Help',
  heroImage: heroChwImage,
  badges: [
    { icon: Shield, label: 'HIPAA Compliant' },
    { icon: CheckCircle, label: 'Medi-Cal Reimbursed' },
    { icon: DollarSign, label: 'Flexible Schedule' },
  ],
};

const MEMBER_HERO: HeroContent = {
  headline: 'Get the help you need, ',
  headlineAccent: 'at no cost.',
  descriptionPre: 'Compass pairs you with a ',
  descriptionBold1: 'trained Community Health Worker',
  descriptionMid: ' who speaks your language and knows your neighborhood — to help with ',
  descriptionBold2: 'housing, food, healthcare,',
  descriptionPost: ' and more.',
  primaryButtonLabel: 'Get Matched with a CHW',
  primaryButtonRoute: 'Waitlist',
  secondaryButtonLabel: 'Learn More',
  heroImage: heroMemberImage,
  badges: [
    { icon: Heart, label: '100% Free' },
    { icon: Users, label: 'Bilingual CHWs' },
    { icon: Clock, label: 'Same-Week Matching' },
  ],
};

// ─── Partner logos data ───────────────────────────────────────────────────────

interface PartnerLogo {
  name: string;
  image: number;
  width?: number;
  height?: number;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const logoAnthem = require('../../assets/logo-anthem.png') as number;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const logoKaiser = require('../../assets/logo-kaiser.png') as number;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const logoMolina = require('../../assets/logo-molina.png') as number;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const logoHealthnet = require('../../assets/logo-healthnet.jpeg') as number;

const PARTNER_LOGOS: PartnerLogo[] = [
  { name: 'Anthem Blue Cross', image: logoAnthem, width: 270, height: 150 },
  { name: 'Kaiser Permanente', image: logoKaiser, width: 270, height: 150 },
  { name: 'Molina Healthcare', image: logoMolina, width: 270, height: 150 },
  { name: 'Health Net', image: logoHealthnet, width: 270, height: 150 },
];

// ─── Service cards data ───────────────────────────────────────────────────────

interface ServiceCard {
  icon: React.FC<{ size: number; color: string }>;
  title: string;
  description: string;
}

const SERVICE_CARDS: ServiceCard[] = [
  {
    icon: Home,
    title: 'Housing',
    description: 'Help members find rental assistance, shelter, and housing stability resources.',
  },
  {
    icon: Pill,
    title: 'Rehab & Recovery',
    description: 'Connect members to substance use recovery, sober living, and peer support.',
  },
  {
    icon: Apple,
    title: 'Food & Pantry',
    description: 'Navigate CalFresh enrollment, food pantries, and nutrition programs.',
  },
  {
    icon: Brain,
    title: 'Mental Health',
    description: 'Refer members to counseling, crisis support, and wellness check-ins.',
  },
  {
    icon: HeartPulse,
    title: 'Healthcare',
    description: 'Assist with Medi-Cal enrollment, appointments, and care coordination.',
  },
  {
    icon: Bus,
    title: 'Transportation Assistance',
    description: 'Coordinate rides to medical appointments, social services, and community resources.',
  },
];

// ─── Hero stats (floating card on hero image) ─────────────────────────────────

const CHW_HERO_STATS = [
  { label: 'MEDI-CAL MEMBERS', value: '3M+', sublabel: 'IN NEED' },
  { label: 'AVG. EARNINGS', value: '$32/hour' },
];

const MEMBER_HERO_STATS = [
  { label: 'SIGN-UP BONUS', value: '$10', sublabel: 'FIRST SESSION' },
  { label: 'MEDI-CAL MEMBER COST', value: '$0' },
];

// ─── How-It-Works steps ───────────────────────────────────────────────────────

interface Step {
  icon: React.FC<{ size: number; color: string }>;
  number: string;
  title: string;
  description: string;
}

const HOW_IT_WORKS: Step[] = [
  {
    icon: Briefcase,
    number: '01',
    title: 'Sign up as a CHW',
    description:
      'Create your profile, verify your training, and set your availability. It takes under 5 minutes.',
  },
  {
    icon: Users,
    number: '02',
    title: 'Get matched with members',
    description:
      'Compass connects you with community members in your neighborhood who need support — housing, food, recovery, or healthcare.',
  },
  {
    icon: DollarSign,
    number: '03',
    title: 'Complete sessions & get paid',
    description:
      'Meet with members, log your sessions, and get reimbursed through Medi-Cal. Track your earnings in real time.',
  },
];

const HOW_IT_WORKS_MEMBER: Step[] = [
  {
    icon: UserPlus,
    number: '01',
    title: 'Tell us what you need',
    description:
      'Share your health goals and the areas where you need support — housing, food, healthcare, or recovery. It takes under 2 minutes.',
  },
  {
    icon: Heart,
    number: '02',
    title: 'Get matched with a local CHW',
    description:
      "We'll pair you with a trained Community Health Worker who speaks your language and knows your neighborhood.",
  },
  {
    icon: CheckCircle,
    number: '03',
    title: 'Complete your first session — and get a $10 reward',
    description:
      "Meet your CHW in person or virtually. Get guidance on housing, food, healthcare, and more. It's 100% covered by Medi-Cal.",
  },
];

// ─── For CHWs benefits data ───────────────────────────────────────────────────

interface Benefit {
  icon: React.FC<{ size: number; color: string }>;
  title: string;
  description: string;
}

const CHW_BENEFITS: Benefit[] = [
  {
    icon: DollarSign,
    title: 'Earn on your schedule',
    description: 'Get reimbursed through Medi-Cal for every session completed.',
  },
  {
    icon: Clock,
    title: 'Flexible hours',
    description: 'Work when it suits you. No minimums, no commitments.',
  },
  {
    icon: MapPin,
    title: 'Stay in your neighborhood',
    description: 'Help people in your own community — no long commutes.',
  },
  {
    icon: Heart,
    title: 'Make real impact',
    description: 'Navigate your neighbors through the services they need most.',
  },
];

// ─── Member benefits (For Medi-Cal Members section) ─────────────────────────

const MEMBER_BENEFITS: Benefit[] = [
  {
    icon: Heart,
    title: '100% free for you',
    description: 'All services are covered by Medi-Cal. No copays, no surprise bills.',
  },
  {
    icon: Users,
    title: 'Bilingual CHWs',
    description: 'Get matched with a CHW who speaks your language and knows your area.',
  },
  {
    icon: Shield,
    title: 'Private & secure',
    description: 'Your information is protected by HIPAA. Only your CHW sees your details.',
  },
  {
    icon: Clock,
    title: 'Earn Rewards!',
    description: 'Receive rewards for completing health actions.',
  },
];

// ─── Mobile First checklist items ─────────────────────────────────────────────

const MOBILE_FEATURES: string[] = [
  'Accept member requests in seconds',
  'Log sessions & track your earnings in real time',
  'Secure messaging with members',
  'Access the full resource directory on the go',
];

const MEMBER_MOBILE_FEATURES: string[] = [
  'Find a CHW near you in seconds',
  'Schedule sessions on your terms',
  'Message your CHW securely anytime',
  'Track your health goals and progress',
];

// ─── Footer link columns ──────────────────────────────────────────────────────

interface FooterColumn {
  heading: string;
  links: string[];
}

const FOOTER_COLUMNS: FooterColumn[] = [
  {
    heading: 'For CHWs',
    links: ['Start Earning', 'How It Works', 'CHW Resources', 'FAQs'],
  },
  {
    heading: 'Company',
    links: ['About', 'Blog', 'Careers', 'Contact'],
  },
  {
    heading: 'Legal',
    links: ['Privacy Policy', 'Terms of Service', 'HIPAA Notice'],
  },
];

// ─── Pulsing dot ──────────────────────────────────────────────────────────────

/**
 * Animated pulsing green dot for the "Launching in Los Angeles County" badge.
 */
function PulsingDot(): React.JSX.Element {
  const opacity = useRef(new Animated.Value(1)).current;

  React.useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.2, duration: 900, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return <Animated.View style={[staticStyles.pulseDot, { opacity }]} />;
}

// ─── Checkmark icon ───────────────────────────────────────────────────────────

/**
 * Small green circle with a white checkmark used in the Mobile First checklist.
 */
function CheckmarkCircle(): React.JSX.Element {
  return (
    <View style={staticStyles.checkmarkCircle}>
      <Text style={staticStyles.checkmarkText}>✓</Text>
    </View>
  );
}

// ─── Content wrapper ─────────────────────────────────────────────────────────

/**
 * Constrains children to MAX_CONTENT_WIDTH and centers them on desktop.
 * On mobile, it is transparent (no max-width constraint).
 */
function ContentWrapper({
  children,
  style,
  isDesktop,
}: {
  children: React.ReactNode;
  style?: object;
  isDesktop: boolean;
}): React.JSX.Element {
  if (!isDesktop) {
    return <View style={style}>{children}</View>;
  }
  return (
    <View
      style={[
        {
          maxWidth: MAX_CONTENT_WIDTH,
          width: '100%',
          alignSelf: 'center',
          paddingHorizontal: 48,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ─── LandingScreen ────────────────────────────────────────────────────────────

/**
 * Full marketing landing screen, responsive to desktop (≥1024 px) and mobile.
 */
export function LandingScreen(): React.JSX.Element {
  const navigation = useNavigation<LandingNavProp>();
  const [activeTab, setActiveTab] = useState<ActiveTab>('chw');
  const { width } = useWindowDimensions();
  const isDesktop = width >= DESKTOP_BREAKPOINT;

  const heroContent = activeTab === 'chw' ? CHW_HERO : MEMBER_HERO;

  // ── Scroll refs ──────────────────────────────────────────────────────────────
  const scrollViewRef = useRef<ScrollView>(null);
  const servicesRef = useRef<View>(null);
  const howItWorksRef = useRef<View>(null);
  const forCHWsRef = useRef<View>(null);

  const scrollToTop = useCallback((): void => {
    scrollViewRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  const scrollToSection = useCallback((ref: React.RefObject<View | null>): void => {
    if (!ref.current || !scrollViewRef.current) return;
    ref.current.measureLayout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (scrollViewRef.current as any).getInnerViewNode
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (scrollViewRef.current as any).getInnerViewNode()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : (scrollViewRef.current as any),
      (_x: number, y: number) => {
        scrollViewRef.current?.scrollTo({ y: y - 80, animated: true });
      },
      () => {},
    );
  }, []);

  const handlePrimaryPress = useCallback((): void => {
    navigation.navigate(heroContent.primaryButtonRoute);
  }, [navigation, heroContent.primaryButtonRoute]);

  const handleWaitlistPress = useCallback((): void => {
    navigation.navigate('Waitlist');
  }, [navigation]);

  const handleSecondaryPress = useCallback((): void => {
    if (activeTab === 'chw') {
      navigation.navigate('Waitlist');
    }
  }, [navigation, activeTab]);

  const handleLoginPress = useCallback((): void => {
    navigation.navigate('Login');
  }, [navigation]);

  const px = isDesktop ? 48 : spacing.lg;
  const sectionPy = isDesktop ? 96 : spacing.xxl;

  // Compute service card width dynamically — 5 columns on desktop, 2 on mobile.
  // The grid uses gap: 12; on desktop the container is MAX_CONTENT_WIDTH - 2*px.
  const serviceGridGap = isDesktop ? 20 : 10;
  const serviceCardCount = isDesktop ? 3 : 2;

  return (
    <SafeAreaView style={staticStyles.safeArea} edges={['top']}>

      {/* ── Fixed navbar ───────────────────────────────────────────────────── */}
      <View
        style={[
          staticStyles.navbar,
          isDesktop && staticStyles.navbarDesktop,
        ]}
      >
        <ContentWrapper isDesktop={isDesktop} style={staticStyles.navbarInner}>
          <View style={staticStyles.navbarLeft}>
            <Image
              source={compassIcon}
              style={staticStyles.navLogo}
              accessibilityIgnoresInvertColors
            />
            <Text style={staticStyles.navWordmark}>
              Compass<Text style={staticStyles.navWordmarkAccent}>CHW</Text>
            </Text>
          </View>

          {/* Desktop-only center nav links */}
          {isDesktop && (
            <View style={staticStyles.navbarCenter}>
              <TouchableOpacity
                style={staticStyles.navLink}
                onPress={scrollToTop}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Home"
              >
                <Text style={staticStyles.navLinkText}>Home</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={staticStyles.navLink}
                onPress={() => scrollToSection(servicesRef)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Services"
              >
                <Text style={staticStyles.navLinkText}>Services</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={staticStyles.navLink}
                onPress={() => scrollToSection(howItWorksRef)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="How It Works"
              >
                <Text style={staticStyles.navLinkText}>How It Works</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={staticStyles.navLink}
                onPress={() => scrollToSection(forCHWsRef)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="How to Earn"
              >
                <Text style={staticStyles.navLinkText}>How to Earn</Text>
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity
            style={staticStyles.navJoinButton}
            onPress={handleWaitlistPress}
            activeOpacity={0.82}
            accessibilityLabel="Join waitlist"
            accessibilityRole="button"
          >
            <Text style={staticStyles.navJoinButtonText}>Join Waitlist</Text>
          </TouchableOpacity>
        </ContentWrapper>
      </View>

      <ScrollView
        ref={scrollViewRef}
        style={staticStyles.scroll}
        contentContainerStyle={staticStyles.scrollContent}
        showsVerticalScrollIndicator={false}
      >

        {/* ════════════════════════════════════════════════════════════════
            SECTION 1 — HERO
        ════════════════════════════════════════════════════════════════ */}

        <View
          style={[
            staticStyles.heroOuter,
            { paddingHorizontal: isDesktop ? 0 : 0 },
          ]}
        >
          {/* Toggle pill — centered above everything */}
          <View style={[staticStyles.toggleContainer, { paddingTop: isDesktop ? 64 : spacing.xl }]}>
            <View style={staticStyles.togglePill}>
              <Pressable
                style={[staticStyles.toggleTab, activeTab === 'chw' && staticStyles.toggleTabActive]}
                onPress={() => setActiveTab('chw')}
                accessibilityRole="button"
                accessibilityLabel="I'm a CHW"
                accessibilityState={{ selected: activeTab === 'chw' }}
              >
                <Text style={[staticStyles.toggleTabText, activeTab === 'chw' && staticStyles.toggleTabTextActive]}>
                  I'm a CHW
                </Text>
              </Pressable>
              <Pressable
                style={[staticStyles.toggleTab, activeTab === 'member' && staticStyles.toggleTabActive]}
                onPress={() => setActiveTab('member')}
                accessibilityRole="button"
                accessibilityLabel="I'm a Medi-Cal Member"
                accessibilityState={{ selected: activeTab === 'member' }}
              >
                <Text style={[staticStyles.toggleTabText, activeTab === 'member' && staticStyles.toggleTabTextActive]}>
                  I'm a Medi-Cal Member
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Hero body — 2-col on desktop, single col on mobile */}
          <ContentWrapper
            isDesktop={isDesktop}
            style={[
              staticStyles.heroContent,
              {
                paddingTop: isDesktop ? 56 : spacing.xl,
                paddingBottom: isDesktop ? 48 : spacing.lg,
                paddingHorizontal: isDesktop ? 48 : px,
              },
            ]}
          >
            <View
              style={[
                staticStyles.heroColumns,
                {
                  flexDirection: isDesktop ? 'row' : 'column',
                  gap: isDesktop ? 64 : spacing.xl,
                  alignItems: isDesktop ? 'center' : 'stretch',
                },
              ]}
            >
              {/* Left column — text */}
              <View style={[staticStyles.heroTextCol, { flex: isDesktop ? 1 : undefined }]}>
                {/* Launch badge */}
                <View style={staticStyles.heroBadge}>
                  <PulsingDot />
                  <Text style={staticStyles.heroBadgeText}>Launching in Los Angeles County</Text>
                </View>

                {/* Headline */}
                <Text
                  style={[
                    staticStyles.heroHeadline,
                    {
                      fontSize: isDesktop ? 72 : 40,
                      lineHeight: isDesktop ? 76 : 44,
                      letterSpacing: isDesktop ? -2 : -1,
                    },
                  ]}
                >
                  {heroContent.headline}
                  <Text style={staticStyles.heroHeadlineAccent}>{heroContent.headlineAccent}</Text>
                </Text>

                {/* Description */}
                <Text
                  style={[
                    staticStyles.heroDescription,
                    { fontSize: isDesktop ? 18 : 16, lineHeight: isDesktop ? 28 : 26 },
                  ]}
                >
                  {heroContent.descriptionPre}
                  <Text style={staticStyles.heroDescriptionBold}>{heroContent.descriptionBold1}</Text>
                  {heroContent.descriptionMid}
                  <Text style={staticStyles.heroDescriptionBold}>{heroContent.descriptionBold2}</Text>
                  {heroContent.descriptionPost}
                </Text>

                {/* CTA buttons — side by side on desktop, stacked on mobile */}
                <View
                  style={[
                    staticStyles.heroButtons,
                    {
                      flexDirection: isDesktop ? 'row' : 'column',
                      gap: isDesktop ? 12 : 10,
                      marginTop: spacing.sm,
                    },
                  ]}
                >
                  <TouchableOpacity
                    style={[
                      staticStyles.heroPrimaryButton,
                      isDesktop && staticStyles.heroPrimaryButtonDesktop,
                    ]}
                    onPress={handlePrimaryPress}
                    activeOpacity={0.85}
                    accessibilityLabel={heroContent.primaryButtonLabel}
                    accessibilityRole="button"
                  >
                    <Text style={staticStyles.heroPrimaryButtonText}>
                      {heroContent.primaryButtonLabel}
                    </Text>
                    <ArrowRight size={16} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>

                {/* Trust badges */}
                <View style={staticStyles.trustBadgesRow}>
                  {heroContent.badges.map((badge) => (
                    <View key={badge.label} style={staticStyles.trustBadge}>
                      <badge.icon size={14} color={colors.primary} />
                      <Text style={staticStyles.trustBadgeText}>{badge.label}</Text>
                    </View>
                  ))}
                </View>
              </View>

              {/* Right column — hero image (desktop only / stacked on mobile) */}
              <View
                style={[
                  staticStyles.heroImageCol,
                  { flex: isDesktop ? 1 : undefined, display: isDesktop ? 'flex' : 'flex' },
                ]}
              >
                <View style={staticStyles.heroImageWrap}>
                  <Image
                    source={heroContent.heroImage}
                    style={[
                      staticStyles.heroImage,
                      { height: isDesktop ? 560 : 280 },
                    ]}
                    accessibilityIgnoresInvertColors
                    accessibilityLabel="Community Health Worker smiling"
                    resizeMode="cover"
                  />

                  {/* Floating stats card at bottom of image */}
                  <View style={staticStyles.heroStatsCard}>
                    {(activeTab === 'chw' ? CHW_HERO_STATS : MEMBER_HERO_STATS).map((stat, index, arr) => (
                      <React.Fragment key={stat.label}>
                        <View style={staticStyles.heroStatItem}>
                          <Text style={staticStyles.heroStatLabel}>{stat.label}</Text>
                          <Text style={staticStyles.heroStatValue}>{stat.value}</Text>
                          {stat.sublabel && (
                            <Text style={staticStyles.heroStatSublabel}>{stat.sublabel}</Text>
                          )}
                        </View>
                        {index < arr.length - 1 && (
                          <View style={staticStyles.heroStatDivider} />
                        )}
                      </React.Fragment>
                    ))}
                  </View>
                </View>
              </View>
            </View>
          </ContentWrapper>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 2 — CLIENT SLIDER
        ════════════════════════════════════════════════════════════════ */}
        <View style={[staticStyles.clientSliderSection, { paddingVertical: sectionPy / 2 }]}>
          <Text style={staticStyles.clientSliderEyebrow}>Trusted Partners</Text>
          <Text
            style={[
              staticStyles.clientSliderHeading,
              { fontSize: isDesktop ? 40 : 22, lineHeight: isDesktop ? 46 : 28 },
            ]}
          >
            Working with leading health organizations
          </Text>

          <InfiniteSlider
            gap={isDesktop ? 24 : 12}
            duration={isDesktop ? 50 : 35}
            fadeEdges
            style={{ marginTop: spacing.lg }}
          >
            {PARTNER_LOGOS.map((logo) => (
              <View key={logo.name} style={staticStyles.clientCard}>
                <Image
                  source={logo.image}
                  style={[staticStyles.clientCardLogo, logo.width ? { width: logo.width, height: logo.height } : undefined]}
                  resizeMode="contain"
                  accessibilityLabel={logo.name}
                />
              </View>
            ))}
          </InfiniteSlider>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 3 — SERVICES
        ════════════════════════════════════════════════════════════════ */}
        <View ref={servicesRef} style={[staticStyles.servicesSection, { paddingTop: sectionPy / 2, paddingBottom: sectionPy }]}>
          <ContentWrapper isDesktop={isDesktop} style={{ paddingHorizontal: isDesktop ? 48 : px }}>
            <Text style={[staticStyles.eyebrowLabel, staticStyles.eyebrowCentered]}>
              {activeTab === 'chw' ? 'Service Areas' : 'Support Areas'}
            </Text>
            <Text
              style={[
                staticStyles.sectionHeading,
                staticStyles.textCentered,
                { fontSize: isDesktop ? 56 : 32, lineHeight: isDesktop ? 60 : 36 },
              ]}
            >
              {activeTab === 'chw'
                ? 'Where CHWs make an impact'
                : 'Ways CompassCHW can support you'}
            </Text>
            <Text
              style={[
                staticStyles.sectionSubheading,
                staticStyles.textCentered,
                { marginBottom: isDesktop ? 48 : 24 },
              ]}
            >
              {activeTab === 'chw'
                ? "As a Compass CHW, you'll guide members through these critical service areas — and get reimbursed for each session."
                : 'Your CHW can help you navigate these areas — connecting you with the right resources, programs, and support at no cost.'}
            </Text>

            {/* Service cards — 3-col grid (2 rows) on desktop, 2-col grid on mobile */}
            <View
              style={[
                staticStyles.serviceCardsGrid,
                {
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  gap: serviceGridGap,
                },
              ]}
            >
              {SERVICE_CARDS.map((card) => (
                <ServiceCardItem
                  key={card.title}
                  card={card}
                  isDesktop={isDesktop}
                  gridGap={serviceGridGap}
                  cardCount={serviceCardCount}
                  containerWidth={
                    isDesktop
                      ? Math.min(width, MAX_CONTENT_WIDTH) - 96
                      : width - px * 2
                  }
                />
              ))}
            </View>

          </ContentWrapper>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 4 — FOR CHWs / FOR MEMBERS (toggles with activeTab)
        ════════════════════════════════════════════════════════════════ */}
        <View ref={forCHWsRef} style={[staticStyles.forChwsSection, { paddingVertical: sectionPy }]}>
          <ContentWrapper isDesktop={isDesktop} style={{ paddingHorizontal: isDesktop ? 48 : px }}>
            <View
              style={[
                staticStyles.twoColRow,
                {
                  flexDirection: isDesktop ? 'row' : 'column',
                  gap: isDesktop ? 80 : spacing.xl,
                  alignItems: isDesktop ? 'center' : 'stretch',
                },
              ]}
            >
              {/* Left — image */}
              <View style={[staticStyles.forChwsImageCol, { flex: isDesktop ? 1 : undefined }]}>
                <View style={staticStyles.forChwsImageWrap}>
                  <Image
                    source={activeTab === 'chw' ? chwMobileImage : heroMemberImage}
                    style={[
                      staticStyles.forChwsImage,
                      { height: isDesktop ? 560 : 320 },
                    ]}
                    accessibilityIgnoresInvertColors
                    accessibilityLabel={activeTab === 'chw' ? 'Community Health Worker using the Compass app' : 'Community member receiving support'}
                    resizeMode="cover"
                  />
                  <View style={staticStyles.forChwsImageOverlay} />
                  {activeTab === 'chw' ? (
                    <View style={staticStyles.earningsCard}>
                      <Text style={staticStyles.earningsCardLabel}>Avg. Earnings</Text>
                      <Text style={staticStyles.earningsCardValue}>
                        $32<Text style={staticStyles.earningsCardSuffix}> / hour</Text>
                      </Text>
                      <Text style={staticStyles.earningsCardNote}>Reimbursed via Medi-Cal</Text>
                    </View>
                  ) : (
                    <View style={staticStyles.earningsCard}>
                      <Text style={staticStyles.earningsCardLabel}>Your Cost</Text>
                      <Text style={staticStyles.earningsCardValue}>
                        $0
                      </Text>
                      <Text style={staticStyles.earningsCardNote}>Covered by Medi-Cal</Text>
                    </View>
                  )}
                </View>
              </View>

              {/* Right — content */}
              <View style={[staticStyles.forChwsTextCol, { flex: isDesktop ? 1 : undefined }]}>
                <Text style={staticStyles.eyebrowLabel}>
                  {activeTab === 'chw' ? 'Why CHWs Choose Compass' : 'Why Members Choose Compass'}
                </Text>
                <Text
                  style={[
                    staticStyles.sectionHeading,
                    { fontSize: isDesktop ? 48 : 28, lineHeight: isDesktop ? 52 : 34 },
                  ]}
                >
                  {activeTab === 'chw' ? (
                    <>Earn money helping{' '}<Text style={staticStyles.accentText}>your neighbors</Text></>
                  ) : (
                    <>Get the support{' '}<Text style={staticStyles.accentText}>you deserve</Text></>
                  )}
                </Text>
                <Text style={staticStyles.bodyText}>
                  {activeTab === 'chw'
                    ? 'Join Compass as a CHW and get reimbursed for every session. Work flexible hours, stay local, and build a career making a real difference in your community.'
                    : 'Compass connects you with a trained Community Health Worker in your neighborhood who can help with housing, food, healthcare, recovery, and more — at no cost to you.'}
                </Text>

                {/* Benefits grid — 2×2 */}
                <View style={staticStyles.benefitsGrid}>
                  {(activeTab === 'chw' ? CHW_BENEFITS : MEMBER_BENEFITS).map((benefit) => (
                    <View key={benefit.title} style={staticStyles.benefitItem}>
                      <View style={staticStyles.benefitIconWrap}>
                        <benefit.icon size={20} color={colors.primary} />
                      </View>
                      <View style={staticStyles.benefitTextBlock}>
                        <Text style={staticStyles.benefitTitle}>{benefit.title}</Text>
                        <Text style={staticStyles.benefitDescription}>{benefit.description}</Text>
                      </View>
                    </View>
                  ))}
                </View>

                <TouchableOpacity
                  style={staticStyles.sectionCta}
                  onPress={activeTab === 'chw' ? handleLoginPress : handleWaitlistPress}
                  activeOpacity={0.85}
                  accessibilityLabel={activeTab === 'chw' ? 'Start Earning Today' : 'Get Matched Now'}
                  accessibilityRole="button"
                >
                  <Text style={staticStyles.sectionCtaText}>
                    {activeTab === 'chw' ? 'Start Earning Today' : 'Get Matched Now'}
                  </Text>
                  <ArrowRight size={16} color="#FFFFFF" />
                </TouchableOpacity>
              </View>
            </View>
          </ContentWrapper>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 5 — HOW IT WORKS (toggles with activeTab)
        ════════════════════════════════════════════════════════════════ */}
        {activeTab === 'chw' ? (
          <View ref={howItWorksRef} style={[staticStyles.howItWorksSection, { paddingVertical: sectionPy }]}>
            <ContentWrapper isDesktop={isDesktop} style={{ paddingHorizontal: isDesktop ? 48 : px }}>
              <Text style={staticStyles.howEyebrow}>How It Works</Text>
              <Text
                style={[
                  staticStyles.howHeading,
                  { fontSize: isDesktop ? 56 : 32, lineHeight: isDesktop ? 60 : 36 },
                ]}
              >
                Three steps to{' '}
                <Text style={staticStyles.howHeadingHighlight}>start earning</Text>
              </Text>

              <View style={{ position: 'relative', marginTop: isDesktop ? 56 : 8 }}>
                {isDesktop && <View style={staticStyles.stepsConnectingLine} />}
                <View
                  style={[
                    staticStyles.stepsRow,
                    {
                      flexDirection: isDesktop ? 'row' : 'column',
                      gap: isDesktop ? 40 : spacing.xxl,
                      alignItems: isDesktop ? 'flex-start' : 'center',
                    },
                  ]}
                >
                  {HOW_IT_WORKS.map((step) => (
                    <View key={step.number} style={[staticStyles.stepItem, { flex: isDesktop ? 1 : undefined }]}>
                      <View style={staticStyles.stepIconCircle}>
                        <step.icon size={24} color={colors.primary} />
                      </View>
                      <Text style={[staticStyles.stepTitle, { fontSize: isDesktop ? 24 : 18 }]}>{step.title}</Text>
                      <Text style={staticStyles.stepDescription}>{step.description}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </ContentWrapper>
          </View>
        ) : (
          <View ref={howItWorksRef} style={[staticStyles.howItWorksMemberSection, { paddingVertical: sectionPy }]}>
            <ContentWrapper isDesktop={isDesktop} style={{ paddingHorizontal: isDesktop ? 48 : px }}>
              <Text style={staticStyles.howMemberEyebrow}>For Medi-Cal Members</Text>
              <Text
                style={[
                  staticStyles.howHeading,
                  { fontSize: isDesktop ? 56 : 32, lineHeight: isDesktop ? 60 : 36 },
                ]}
              >
                Three steps to{' '}
                <Text style={staticStyles.howHeadingHighlight}>get help</Text>
              </Text>

              <View style={{ position: 'relative', marginTop: isDesktop ? 56 : 8 }}>
                {isDesktop && <View style={[staticStyles.stepsConnectingLine, { backgroundColor: 'rgba(255,255,255,0.15)' }]} />}
                <View
                  style={[
                    staticStyles.stepsRow,
                    {
                      flexDirection: isDesktop ? 'row' : 'column',
                      gap: isDesktop ? 40 : spacing.xxl,
                      alignItems: isDesktop ? 'flex-start' : 'center',
                    },
                  ]}
                >
                  {HOW_IT_WORKS_MEMBER.map((step) => (
                    <View key={step.number} style={[staticStyles.stepItem, { flex: isDesktop ? 1 : undefined }]}>
                      <View style={staticStyles.stepIconCircle}>
                        <step.icon size={24} color={colors.primary} />
                      </View>
                      <Text style={[staticStyles.stepTitle, { fontSize: isDesktop ? 24 : 18 }]}>{step.title}</Text>
                      <Text style={staticStyles.stepDescription}>{step.description}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </ContentWrapper>
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════════
            SECTION 6 — MOBILE FIRST
        ════════════════════════════════════════════════════════════════ */}
        <View style={[staticStyles.mobileFirstSection, { paddingVertical: sectionPy }]}>
          <ContentWrapper isDesktop={isDesktop} style={{ paddingHorizontal: isDesktop ? 48 : px }}>
            <View
              style={[
                staticStyles.twoColRow,
                {
                  flexDirection: isDesktop ? 'row' : 'column',
                  gap: isDesktop ? 80 : spacing.xl,
                  alignItems: isDesktop ? 'center' : 'stretch',
                },
              ]}
            >
              {/* Left — text content */}
              <View style={[staticStyles.mobileFirstTextCol, { flex: isDesktop ? 1 : undefined }]}>
                <Text style={staticStyles.eyebrowLabel}>
                  {activeTab === 'chw' ? 'Mobile-First Platform' : 'Help At Your Fingertips'}
                </Text>
                <Text
                  style={[
                    staticStyles.sectionHeading,
                    { fontSize: isDesktop ? 48 : 28, lineHeight: isDesktop ? 52 : 34 },
                  ]}
                >
                  {activeTab === 'chw' ? (
                    <>Manage your CHW work{' '}<Text style={staticStyles.accentText}>from your pocket</Text></>
                  ) : (
                    <>Get help navigating{' '}<Text style={staticStyles.accentText}>what matters most</Text></>
                  )}
                </Text>
                <Text style={staticStyles.bodyText}>
                  {activeTab === 'chw'
                    ? 'Accept requests, log sessions, track earnings, and communicate with members — all from your phone. Compass is built mobile-first because your work happens in the field, not behind a desk.'
                    : 'Find a CHW, schedule sessions, message your health worker, and track your goals — all from your phone. Compass makes getting help as easy as sending a text.'}
                </Text>

                <View style={staticStyles.mobileFeaturesList}>
                  {(activeTab === 'chw' ? MOBILE_FEATURES : MEMBER_MOBILE_FEATURES).map((feature) => (
                    <View key={feature} style={staticStyles.mobileFeatureRow}>
                      <CheckmarkCircle />
                      <Text style={staticStyles.mobileFeatureText}>{feature}</Text>
                    </View>
                  ))}
                </View>

                <TouchableOpacity
                  style={[staticStyles.sectionCta, { marginTop: spacing.md }]}
                  onPress={handleWaitlistPress}
                  activeOpacity={0.85}
                  accessibilityLabel="Join Waitlist"
                  accessibilityRole="button"
                >
                  <Text style={staticStyles.sectionCtaText}>Join Waitlist</Text>
                  <ArrowRight size={16} color="#FFFFFF" />
                </TouchableOpacity>
              </View>

              {/* Right — phone mockup */}
              <View
                style={[
                  staticStyles.mobileFirstMockupCol,
                  { flex: isDesktop ? 1 : undefined, alignItems: 'center' },
                ]}
              >
                <PhoneMockup availableWidth={isDesktop ? 320 : width - spacing.lg * 2} />
              </View>
            </View>
          </ContentWrapper>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 7 — CTA SECTION
        ════════════════════════════════════════════════════════════════ */}
        <View style={[staticStyles.ctaSection, { minHeight: isDesktop ? 600 : 520 }]}>
          <Image
            source={neighborhoodImage}
            style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }]}
            accessibilityIgnoresInvertColors
            accessibilityLabel="Los Angeles County neighborhood aerial view"
            resizeMode="cover"
          />
          <View style={[StyleSheet.absoluteFill, staticStyles.ctaOverlay]} />

          <View style={{ zIndex: 1, flex: 1, justifyContent: 'center' }}>
            <ContentWrapper
              isDesktop={isDesktop}
              style={[
                staticStyles.ctaContent,
                { paddingVertical: isDesktop ? 140 : 80, paddingHorizontal: isDesktop ? 48 : px },
              ]}
            >
              <Text style={staticStyles.ctaEyebrow}>Limited Early Access</Text>
              <Text
                style={[
                  staticStyles.ctaHeading,
                  { fontSize: isDesktop ? 56 : 32, lineHeight: isDesktop ? 60 : 38 },
                ]}
              >
                {activeTab === 'chw'
                  ? 'Ready to start earning as a CHW?'
                  : 'Being healthy is rewarding!'}
              </Text>
              <Text style={staticStyles.ctaBody}>
                {activeTab === 'chw'
                  ? "We're opening Compass to CHWs in Los Angeles County first. Secure your spot, set your availability, and start getting matched with members who need your help."
                  : "We're opening Compass to Medi-Cal members in Los Angeles County first. Sign up, get matched with a local CHW, and earn rewards for taking steps toward better health."}
              </Text>

              <View
                style={[
                  staticStyles.ctaButtons,
                  {
                    flexDirection: isDesktop ? 'row' : 'column',
                    gap: isDesktop ? 16 : 10,
                    justifyContent: 'center',
                    marginTop: spacing.md,
                  },
                ]}
              >
                <TouchableOpacity
                  style={staticStyles.ctaOutlineButton}
                  onPress={handleLoginPress}
                  activeOpacity={0.85}
                  accessibilityLabel="Join as a CHW"
                  accessibilityRole="button"
                >
                  <Text style={staticStyles.ctaOutlineButtonText}>Join as a CHW</Text>
                  <ArrowRight size={16} color="#FFFFFF" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={staticStyles.ctaOutlineButtonSecondary}
                  onPress={handleWaitlistPress}
                  activeOpacity={0.75}
                  accessibilityLabel="I'm a Medi-Cal Member"
                  accessibilityRole="button"
                >
                  <Text style={staticStyles.ctaOutlineButtonSecondaryText}>
                    I'm a Medi-Cal Member
                  </Text>
                </TouchableOpacity>
              </View>
            </ContentWrapper>
          </View>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 8 — FOOTER
        ════════════════════════════════════════════════════════════════ */}
        <View style={staticStyles.footer}>
          <ContentWrapper isDesktop={isDesktop} style={{ paddingHorizontal: isDesktop ? 48 : px }}>
            <View
              style={[
                staticStyles.footerTopRow,
                {
                  flexDirection: isDesktop ? 'row' : 'column',
                  gap: isDesktop ? 80 : spacing.xl,
                  paddingTop: sectionPy,
                  paddingBottom: isDesktop ? 56 : spacing.xxl,
                  alignItems: isDesktop ? 'flex-start' : 'stretch',
                },
              ]}
            >
              {/* Column 1 — brand */}
              <View style={[staticStyles.footerBrandCol, { flex: isDesktop ? 1.5 : undefined }]}>
                <View style={staticStyles.footerLogoRow}>
                  <Image
                    source={compassIcon}
                    style={staticStyles.footerLogo}
                    accessibilityIgnoresInvertColors
                  />
                  <Text style={staticStyles.footerWordmark}>
                    Compass<Text style={staticStyles.footerWordmarkAccent}>CHW</Text>
                  </Text>
                </View>
                <Text style={staticStyles.footerTagline}>
                  The marketplace connecting Community Health Workers with the neighbors who need them.
                </Text>
              </View>

              {/* Link columns */}
              {FOOTER_COLUMNS.map((col) => (
                <View key={col.heading} style={[staticStyles.footerColumn, { flex: isDesktop ? 1 : undefined }]}>
                  <Text style={staticStyles.footerColumnHeading}>{col.heading}</Text>
                  {col.links.map((link) => (
                    <TouchableOpacity
                      key={link}
                      accessibilityRole="link"
                      accessibilityLabel={link}
                      hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
                    >
                      <Text style={staticStyles.footerLink}>{link}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </View>

            <View style={staticStyles.footerDivider} />

            {/* Bottom row */}
            <View
              style={[
                staticStyles.footerBottomRow,
                {
                  flexDirection: isDesktop ? 'row' : 'column',
                  justifyContent: isDesktop ? 'space-between' : 'flex-start',
                  paddingVertical: spacing.xl,
                  gap: spacing.md,
                },
              ]}
            >
              <Text style={staticStyles.footerCopyright}>
                © {new Date().getFullYear()} Compass CHW. All rights reserved.
              </Text>
              <View style={staticStyles.footerSocialRow}>
                {['Twitter', 'LinkedIn', 'Instagram'].map((network) => (
                  <TouchableOpacity
                    key={network}
                    onPress={() => Linking.openURL('https://compasschw.com').catch(() => null)}
                    accessibilityRole="link"
                    accessibilityLabel={`CompassCHW on ${network}`}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={staticStyles.footerSocialLink}>{network}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </ContentWrapper>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ─── ServiceCardItem ─────────────────────────────────────────────────────────

/**
 * A single service card. Computes its own width from the container geometry
 * so the grid fills correctly on both desktop (5 col) and mobile (2 col).
 */
function ServiceCardItem({
  card,
  isDesktop,
  gridGap,
  cardCount,
  containerWidth,
}: {
  card: ServiceCard;
  isDesktop: boolean;
  gridGap: number;
  cardCount: number;
  containerWidth: number;
}): React.JSX.Element {
  const cardWidth = (containerWidth - gridGap * (cardCount - 1)) / cardCount;

  return (
    <View
      style={[
        staticStyles.serviceCard,
        { width: cardWidth },
      ]}
    >
      <View style={staticStyles.serviceCardIconWrap}>
        <card.icon size={isDesktop ? 26 : 22} color={colors.primary} />
      </View>
      <Text style={[staticStyles.serviceCardTitle, { fontSize: isDesktop ? 17 : 15 }]}>
        {card.title}
      </Text>
      <Text style={staticStyles.serviceCardDescription}>{card.description}</Text>
    </View>
  );
}

// ─── PhoneMockup ─────────────────────────────────────────────────────────────

/**
 * Decorative phone UI mockup used in the Mobile First section.
 *
 * @param availableWidth - The width of the container. The phone will be capped
 *   at 280 px and height will be proportionally derived at a 2:1 ratio (h = w * 2).
 */
function PhoneMockup({ availableWidth }: { availableWidth: number }): React.JSX.Element {
  const phoneWidth = Math.min(280, availableWidth);
  const phoneHeight = phoneWidth * 2; // 2:1 ratio — 280 × 560
  const bezel = Math.round(phoneWidth * 0.04); // ~11px at 280
  const cornerRadius = 36;
  const innerRadius = cornerRadius - bezel;

  return (
    // Shadow wrapper — separate from the clipping view so shadow renders correctly
    <View
      style={[
        staticStyles.phoneShadowWrapper,
        {
          width: phoneWidth,
          height: phoneHeight,
          borderRadius: cornerRadius,
          marginVertical: spacing.xl,
        },
      ]}
    >
      {/* Bezel + screen (overflow hidden for clip) */}
      <View
        style={[
          staticStyles.phoneMockupOuter,
          {
            width: phoneWidth,
            height: phoneHeight,
            borderRadius: cornerRadius,
            padding: bezel,
          },
        ]}
      >
        {/* Dynamic island / notch */}
        <View
          style={[
            staticStyles.phoneMockupNotch,
            { width: Math.round(phoneWidth * 0.37), marginLeft: -Math.round(phoneWidth * 0.185) },
          ]}
        />

        {/* Screen area fills all remaining height above the bottom nav */}
        <View
          style={[
            staticStyles.phoneMockupInner,
            {
              borderTopLeftRadius: innerRadius,
              borderTopRightRadius: innerRadius,
              flex: 1,
            },
          ]}
        >
          {/* Status bar */}
          <View style={staticStyles.phoneStatusBar}>
            <Text style={staticStyles.phoneStatusTime}>9:41</Text>
            <View style={staticStyles.phoneStatusIcons}>
              <View style={staticStyles.phoneStatusIcon} />
              <View style={staticStyles.phoneStatusIcon} />
              <View style={[staticStyles.phoneStatusIcon, staticStyles.phoneStatusIconGreen]} />
            </View>
          </View>

          {/* App header */}
          <View style={staticStyles.phoneAppHeader}>
            <Smartphone size={14} color={colors.primary} />
            <Text style={staticStyles.phoneAppTitle}>Compass</Text>
          </View>

          <Text style={staticStyles.phoneWelcome}>Welcome back, Carlos</Text>
          <Text style={staticStyles.phoneSubtitle}>You have 2 sessions today</Text>

          {/* Session card — primary green */}
          <View style={staticStyles.phoneSessionCard}>
            <View style={staticStyles.phoneSessionCardTop}>
              <View>
                <Text style={staticStyles.phoneSessionTitle}>Housing Support</Text>
                <Text style={staticStyles.phoneSessionSub}>w/ Maria G.</Text>
              </View>
              <View style={staticStyles.phoneSessionTimeBadge}>
                <Text style={staticStyles.phoneSessionTime}>2:00 PM</Text>
              </View>
            </View>
            <Text style={staticStyles.phoneSessionDesc}>Rental assistance application review</Text>
          </View>

          {/* Two stat cards side by side */}
          <View style={staticStyles.phoneStatsRow}>
            <View style={staticStyles.phoneStatCard}>
              <Text style={staticStyles.phoneStatValue}>$176</Text>
              <Text style={staticStyles.phoneStatLabel}>This Week</Text>
            </View>
            <View style={staticStyles.phoneStatCard}>
              <Text style={staticStyles.phoneStatValue}>24</Text>
              <Text style={staticStyles.phoneStatLabel}>Sessions Done</Text>
            </View>
          </View>
        </View>

        {/* Bottom nav — inside the bezel, rounded bottom corners */}
        <View
          style={[
            staticStyles.phoneBottomNav,
            { borderBottomLeftRadius: innerRadius, borderBottomRightRadius: innerRadius },
          ]}
        >
          {['Home', 'Requests', 'Sessions', 'Earnings'].map((item) => (
            <View key={item} style={staticStyles.phoneNavItem}>
              <View style={[staticStyles.phoneNavDot, item === 'Home' && staticStyles.phoneNavDotActive]} />
              <Text style={staticStyles.phoneNavLabel}>{item}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// ─── Static styles (not layout-dependent) ────────────────────────────────────

/**
 * All styles that don't change based on viewport width live here.
 * Responsive overrides are applied inline via `isDesktop` flags in the JSX.
 */
const staticStyles = StyleSheet.create({

  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // ── Navbar ──────────────────────────────────────────────────────────────────
  navbar: {
    height: 64,
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    elevation: 2,
    ...Platform.select({
      ios: {
        shadowColor: colors.foreground,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
    }),
    zIndex: 10,
    justifyContent: 'center',
  },
  navbarDesktop: {
    height: 72,
  },
  navbarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  navbarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  navLogo: {
    width: 28,
    height: 28,
    borderRadius: 7,
  },
  navWordmark: {
    fontFamily: fonts.display,
    fontSize: 20,
    color: colors.foreground,
    letterSpacing: -0.4,
  },
  navWordmarkAccent: {
    color: colors.secondary,
  },
  navJoinButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  navJoinButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#FFFFFF',
    letterSpacing: 0.1,
  },
  navbarCenter: {
    flexDirection: 'row',
    gap: 32,
    alignItems: 'center',
  },
  navLink: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  navLinkText: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
  },

  // ── Scroll ──────────────────────────────────────────────────────────────────
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 0 },

  // ── Toggle ──────────────────────────────────────────────────────────────────
  toggleContainer: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  togglePill: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radii.full,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
    ...Platform.select({
      ios: {
        shadowColor: colors.foreground,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 3,
      },
      android: { elevation: 1 },
    }),
  },
  toggleTab: {
    paddingHorizontal: spacing.md + 8,
    paddingVertical: 10,
    borderRadius: radii.full,
  },
  toggleTabActive: {
    backgroundColor: colors.primary,
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
      android: { elevation: 3 },
    }),
  },
  toggleTabText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.mutedForeground,
  },
  toggleTabTextActive: {
    color: '#FFFFFF',
  },

  // ── Hero ────────────────────────────────────────────────────────────────────
  heroOuter: {
    backgroundColor: colors.background,
  },
  heroContent: {},
  heroColumns: {},
  heroTextCol: {
    gap: spacing.md,
  },
  heroImageCol: {},
  heroImageWrap: {
    position: 'relative',
    borderRadius: radii.xxl,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: colors.foreground,
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.18,
        shadowRadius: 32,
      },
      android: { elevation: 12 },
    }),
  },
  heroImage: {
    width: '100%',
    resizeMode: 'cover',
  },
  // Floating stats card at bottom of hero image
  heroStatsCard: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(61,90,62,0.96)',
    borderRadius: radii.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 22,
    paddingHorizontal: 20,
    gap: 0,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.25,
        shadowRadius: 16,
      },
      android: { elevation: 8 },
    }),
  },
  heroStatItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  heroStatLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: 'rgba(255,255,255,0.75)',
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  heroStatValue: {
    fontFamily: fonts.display,
    fontSize: 28,
    color: '#FFFFFF',
    letterSpacing: -0.6,
    textAlign: 'center',
    lineHeight: 32,
  },
  heroStatSublabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: 'rgba(255,255,255,0.75)',
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  heroStatDivider: {
    width: 1,
    height: 60,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginHorizontal: 4,
  },
  heroBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    backgroundColor: `${colors.primary}1A`,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  heroBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.primary,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  heroHeadline: {
    fontFamily: fonts.display,
    color: colors.foreground,
  },
  heroHeadlineAccent: {
    color: colors.secondary,
  },
  heroDescription: {
    fontFamily: fonts.body,
    color: colors.mutedForeground,
  },
  heroDescriptionBold: {
    fontFamily: fonts.bodyBold,
    color: colors.foreground,
  },
  heroButtons: {},
  heroPrimaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
  },
  heroPrimaryButtonDesktop: {
    paddingHorizontal: spacing.xl,
    alignSelf: 'flex-start',
  },
  heroPrimaryButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: '#FFFFFF',
  },
  heroSecondaryButton: {
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroSecondaryButtonDesktop: {
    paddingHorizontal: spacing.xl,
    alignSelf: 'flex-start',
  },
  heroSecondaryButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: colors.primary,
  },
  trustBadgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  trustBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    backgroundColor: colors.card,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    ...Platform.select({
      ios: {
        shadowColor: colors.foreground,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 2,
      },
      android: { elevation: 1 },
    }),
  },
  trustBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.foreground,
  },

  // ── Client Slider ────────────────────────────────────────────────────────────
  clientSliderSection: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  clientSliderEyebrow: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.8,
    color: colors.mutedForeground,
    textTransform: 'uppercase',
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  clientSliderHeading: {
    fontFamily: fonts.display,
    letterSpacing: -0.5,
    color: colors.foreground,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  clientCardsScroll: {
    gap: spacing.lg,
    paddingVertical: spacing.xs,
  },
  clientCard: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: radii.lg,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  clientCardLogo: {
    width: 180,
    height: 100,
  },
  clientCardInitialsWrap: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    backgroundColor: `${colors.primary}1A`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clientCardInitials: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    color: colors.primary,
    letterSpacing: 0.3,
  },
  clientCardName: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.foreground,
  },

  // ── Services ─────────────────────────────────────────────────────────────────
  servicesSection: {
    backgroundColor: colors.background,
  },
  serviceCardsGrid: {},
  serviceCard: {
    backgroundColor: colors.card,
    borderRadius: radii.xl,
    padding: spacing.md + 4,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    ...Platform.select({
      ios: {
        shadowColor: colors.foreground,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 6,
      },
      android: { elevation: 1 },
    }),
  },
  serviceCardIconWrap: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    backgroundColor: `${colors.primary}1A`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serviceCardTitle: {
    fontFamily: fonts.display,
    color: colors.foreground,
    letterSpacing: -0.2,
  },
  serviceCardDescription: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 18,
    color: colors.mutedForeground,
  },

  // Stats bar — dark primary bar below service cards
  statsBar: {
    backgroundColor: colors.primary,
    borderRadius: radii.xl,
    overflow: 'hidden',
  },
  statCell: {
    padding: spacing.lg,
    gap: spacing.xs,
    alignItems: 'center',
  },
  statCellBorderRight: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(255,255,255,0.2)',
  },
  statCellBorderBottom: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.2)',
  },
  statValue: {
    fontFamily: fonts.display,
    color: '#FFFFFF',
    letterSpacing: -1,
    textAlign: 'center',
  },
  statLabel: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: 'rgba(255,255,255,0.65)',
    textAlign: 'center',
  },

  // ── How It Works ─────────────────────────────────────────────────────────────
  howItWorksSection: {
    backgroundColor: colors.compassDark,
  },
  howEyebrow: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.6,
    color: 'rgba(255,255,255,0.55)',
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  howHeading: {
    fontFamily: fonts.display,
    color: '#FFFFFF',
    textAlign: 'center',
    letterSpacing: -1,
  },
  howHeadingHighlight: {
    color: colors.secondary,
  },
  // Horizontal connecting line between steps (desktop only)
  stepsConnectingLine: {
    position: 'absolute',
    top: 28, // center of the 56px icon circle
    left: '16.67%', // ~1/6 of container (after first icon center)
    right: '16.67%',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.15)',
    zIndex: 0,
  },
  stepsRow: {},
  stepItem: {
    alignItems: 'center',
    gap: spacing.md,
    zIndex: 1,
  },
  stepIconCircle: {
    width: 56,
    height: 56,
    borderRadius: radii.full,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#FFFFFF',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },
  stepTitle: {
    fontFamily: fonts.display,
    color: '#FFFFFF',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  stepDescription: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 22,
    color: 'rgba(255,255,255,0.65)',
    textAlign: 'center',
    maxWidth: 280,
  },
  // ── How It Works — Member variant ──────────────────────────────────────────
  howItWorksMemberSection: {
    backgroundColor: colors.compassDark,
  },
  howMemberEyebrow: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.6,
    color: 'rgba(255,255,255,0.55)',
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  stepIconCircleMember: {
    width: 56,
    height: 56,
    borderRadius: radii.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },

  // ── For CHWs ──────────────────────────────────────────────────────────────────
  forChwsSection: {
    backgroundColor: colors.background,
  },
  twoColRow: {},
  forChwsImageCol: {},
  forChwsTextCol: {
    gap: spacing.md,
  },
  forChwsImageWrap: {
    position: 'relative',
    borderRadius: radii.xxl,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: colors.foreground,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.15,
        shadowRadius: 20,
      },
      android: { elevation: 8 },
    }),
  },
  forChwsImage: {
    width: '100%',
    resizeMode: 'cover',
  },
  forChwsImageOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 200,
    backgroundColor: 'rgba(20,43,26,0.45)',
  },
  earningsCard: {
    position: 'absolute',
    bottom: spacing.md + 4,
    left: spacing.md + 4,
    right: spacing.md + 4,
    backgroundColor: 'rgba(61,90,62,0.95)',
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.xs,
    alignItems: 'center',
  },
  earningsCardLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    letterSpacing: 1.2,
    color: 'rgba(255,255,255,0.65)',
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  earningsCardValue: {
    fontFamily: fonts.display,
    fontSize: 28,
    lineHeight: 32,
    color: '#FFFFFF',
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  earningsCardSuffix: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: 'rgba(255,255,255,0.65)',
  },
  earningsCardNote: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.secondary,
    textAlign: 'center',
  },

  // ── Mobile First ─────────────────────────────────────────────────────────────
  mobileFirstSection: {
    backgroundColor: '#efe8df',
  },
  mobileFirstTextCol: {
    gap: spacing.md,
  },
  mobileFirstMockupCol: {},
  mobileFeaturesList: {
    gap: spacing.md,
  },
  mobileFeatureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
  },
  mobileFeatureText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.foreground,
    flex: 1,
  },

  // ── Phone mockup ──────────────────────────────────────────────────────────────
  // Shadow wrapper: renders the drop shadow without clipping it.
  // width, height, borderRadius, marginVertical set dynamically.
  phoneShadowWrapper: {
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 16 },
        shadowOpacity: 0.28,
        shadowRadius: 32,
      },
      android: { elevation: 16 },
    }),
  },
  // Bezel container: clips inner screen content. Overflow hidden required.
  // width, height, borderRadius, padding set dynamically.
  phoneMockupOuter: {
    backgroundColor: colors.compassDark,
    overflow: 'hidden',
  },
  phoneMockupNotch: {
    position: 'absolute',
    top: 0,
    left: '50%',
    height: 28,
    backgroundColor: colors.compassDark,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    zIndex: 2,
  },
  phoneMockupInner: {
    backgroundColor: colors.card,
    // paddingTop: large enough to clear the notch
    paddingTop: 36,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    // flex: 1 is applied inline so the inner screen fills remaining height
    // (bottom nav is rendered outside this view, inside the outer bezel)
  },
  phoneStatusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  phoneStatusTime: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: colors.foreground,
  },
  phoneStatusIcons: {
    flexDirection: 'row',
    gap: 3,
  },
  phoneStatusIcon: {
    width: 12,
    height: 7,
    backgroundColor: `${colors.foreground}40`,
    borderRadius: 2,
  },
  phoneStatusIconGreen: {
    width: 16,
    backgroundColor: colors.primary,
  },
  phoneAppHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: 2,
  },
  phoneAppTitle: {
    fontFamily: fonts.display,
    fontSize: 13,
    color: colors.foreground,
    letterSpacing: -0.2,
  },
  phoneWelcome: {
    fontFamily: fonts.display,
    fontSize: 14,
    color: colors.foreground,
    letterSpacing: -0.3,
  },
  phoneSubtitle: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.mutedForeground,
  },
  phoneSessionCard: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  phoneSessionCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  phoneSessionTitle: {
    fontFamily: fonts.displaySemibold,
    fontSize: 12,
    color: '#FFFFFF',
  },
  phoneSessionSub: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: 'rgba(255,255,255,0.65)',
  },
  phoneSessionTimeBadge: {
    backgroundColor: '#FFFFFF',
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  phoneSessionTime: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: colors.primary,
  },
  phoneSessionDesc: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: 'rgba(255,255,255,0.65)',
  },
  phoneStatsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  phoneStatCard: {
    flex: 1,
    backgroundColor: colors.muted,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  phoneStatValue: {
    fontFamily: fonts.display,
    fontSize: 16,
    color: colors.foreground,
    letterSpacing: -0.4,
  },
  phoneStatLabel: {
    fontFamily: fonts.body,
    fontSize: 9,
    color: colors.mutedForeground,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  phoneBottomNav: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    // borderBottomLeftRadius / borderBottomRightRadius set dynamically in component
  },
  phoneNavItem: {
    alignItems: 'center',
    gap: 3,
    flex: 1,
  },
  phoneNavDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.muted,
  },
  phoneNavDotActive: {
    backgroundColor: colors.primary,
  },
  phoneNavLabel: {
    fontFamily: fonts.body,
    fontSize: 8,
    color: colors.mutedForeground,
    textAlign: 'center',
  },

  // ── CTA Section ───────────────────────────────────────────────────────────────
  ctaSection: {
    position: 'relative',
    overflow: 'hidden',
  },
  ctaOverlay: {
    backgroundColor: 'rgba(61,90,62,0.92)',
  },
  ctaContent: {
    gap: spacing.md,
    alignItems: 'center',
  },
  ctaEyebrow: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.6,
    color: 'rgba(255,255,255,0.55)',
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  ctaHeading: {
    fontFamily: fonts.display,
    letterSpacing: -1,
    color: '#FFFFFF',
    textAlign: 'center',
    maxWidth: 680,
  },
  ctaBody: {
    fontFamily: fonts.body,
    fontSize: 17,
    lineHeight: 26,
    color: 'rgba(255,255,255,0.65)',
    textAlign: 'center',
    maxWidth: 560,
  },
  ctaButtons: {
    alignItems: 'center',
  },
  ctaOutlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
    borderRadius: radii.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
  },
  ctaOutlineButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: '#FFFFFF',
  },
  ctaOutlineButtonSecondary: {
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    borderRadius: radii.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaOutlineButtonSecondaryText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: '#FFFFFF',
  },

  // ── Footer ────────────────────────────────────────────────────────────────────
  footer: {
    backgroundColor: colors.compassDark,
  },
  footerTopRow: {},
  footerBrandCol: {
    gap: spacing.md,
  },
  footerLogoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  footerLogo: {
    width: 24,
    height: 24,
    borderRadius: 5,
  },
  footerWordmark: {
    fontFamily: fonts.display,
    fontSize: 18,
    color: '#FFFFFF',
    letterSpacing: -0.3,
  },
  footerWordmarkAccent: {
    color: colors.secondary,
  },
  footerTagline: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 20,
    color: 'rgba(255,255,255,0.55)',
    maxWidth: 280,
  },
  footerColumn: {
    gap: spacing.sm,
  },
  footerColumnHeading: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.5,
    color: '#FFFFFF',
    marginBottom: spacing.xs,
  },
  footerLink: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 24,
    color: 'rgba(255,255,255,0.55)',
  },
  footerDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  footerBottomRow: {},
  footerCopyright: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
  },
  footerSocialRow: {
    flexDirection: 'row',
    gap: spacing.xl,
  },
  footerSocialLink: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: 'rgba(255,255,255,0.45)',
  },

  // ── Shared typographic utilities ─────────────────────────────────────────────
  eyebrowLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.6,
    color: colors.primary,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  eyebrowCentered: {
    textAlign: 'center',
  },
  sectionHeading: {
    fontFamily: fonts.display,
    color: colors.foreground,
    letterSpacing: -1,
    marginBottom: spacing.xs,
  },
  textCentered: {
    textAlign: 'center',
  },
  sectionSubheading: {
    fontFamily: fonts.body,
    fontSize: 17,
    lineHeight: 26,
    color: colors.mutedForeground,
  },
  accentText: {
    color: colors.secondary,
  },
  bodyText: {
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: 26,
    color: colors.mutedForeground,
  },

  // ── Shared button styles ──────────────────────────────────────────────────────
  sectionCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    alignSelf: 'flex-start',
  },
  sectionCtaText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: '#FFFFFF',
  },

  // ── Benefit cards ─────────────────────────────────────────────────────────────
  benefitsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  benefitItem: {
    width: '47%',
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  benefitIconWrap: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: `${colors.primary}1A`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  benefitTextBlock: {
    flex: 1,
    gap: 2,
  },
  benefitTitle: {
    fontFamily: fonts.displaySemibold,
    fontSize: 13,
    color: colors.foreground,
    lineHeight: 18,
  },
  benefitDescription: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: colors.mutedForeground,
  },

  // ── PulsingDot + CheckmarkCircle ─────────────────────────────────────────────
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.secondary,
  },
  checkmarkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkmarkText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: fonts.bodySemibold,
    lineHeight: 18,
  },
});
