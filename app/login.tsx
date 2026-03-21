// app/login.tsx
// Staff login screen (waiters, managers, admins).
// Shows the restaurant logo from restaurant_customisations when available.
// Patrons do NOT log in — they use the app as a guest (requestor device).
//
// On successful login: all staff roles → /notifications (WaiterDashboardGrid)

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useTheme } from '../lib/ThemeContext';
import { useAuth } from '../lib/AuthContext';

export default function LoginScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { signIn, session, profile, isLoading: authLoading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If already authenticated redirect to the staff dashboard
  if (!authLoading && session && profile) {
    return <Redirect href="/notifications" />;
  }

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace('/notifications');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed. Please try again.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const styles = useMemo(
    () => createStyles(theme.primaryColor, theme.borderRadius),
    [theme.primaryColor, theme.borderRadius]
  );

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.backgroundColor }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.content}>
        {/* ── Brand header ── */}
        <View style={styles.brand}>
          {theme.logoUrl ? (
            <Image
              source={{ uri: theme.logoUrl }}
              style={styles.logo}
              resizeMode="contain"
            />
          ) : (
            <Text style={[styles.logoEmoji, { color: theme.primaryColor }]}>🍽️</Text>
          )}
          <Text style={[styles.appName, { color: theme.textColor, fontFamily: theme.fontFamily }]}>
            EasyDine
          </Text>
          <Text style={[styles.subtitle, { color: theme.textColor }]}>Staff Login</Text>
        </View>

        {/* ── Form ── */}
        <View style={styles.form}>
          <Text style={[styles.label, { color: theme.textColor }]}>Email</Text>
          <TextInput
            style={[
              styles.input,
              { borderColor: theme.primaryColor, color: theme.textColor, borderRadius: theme.borderRadius },
            ]}
            placeholder="your@email.com"
            placeholderTextColor="#999"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isLoading}
          />

          <Text style={[styles.label, { color: theme.textColor }]}>Password</Text>
          <TextInput
            style={[
              styles.input,
              { borderColor: theme.primaryColor, color: theme.textColor, borderRadius: theme.borderRadius },
            ]}
            placeholder="••••••••"
            placeholderTextColor="#999"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            editable={!isLoading}
          />

          {error && <Text style={styles.errorText}>{error}</Text>}

          <TouchableOpacity
            style={[
              styles.loginBtn,
              { backgroundColor: theme.primaryColor, borderRadius: theme.borderRadius },
              isLoading && styles.btnDisabled,
            ]}
            onPress={handleLogin}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.loginBtnText}>Sign In</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function createStyles(primaryColor: string, borderRadius: number) {
  return StyleSheet.create({
    container: { flex: 1 },
    content: { flexGrow: 1, justifyContent: 'center', padding: 32, gap: 24 },

    brand: { alignItems: 'center', gap: 8 },
    logo: {
      width: 100,
      height: 100,
      borderRadius: 12,
    },
    logoEmoji: { fontSize: 56 },
    appName: { fontSize: 32, fontWeight: 'bold' },
    subtitle: { fontSize: 16, opacity: 0.7 },

    form: { gap: 12 },
    label: { fontSize: 14, fontWeight: '600' },
    input: {
      borderWidth: 2,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
    },
    errorText: { color: '#D32F2F', fontSize: 13, textAlign: 'center' },

    loginBtn: { paddingVertical: 16, alignItems: 'center', marginTop: 8 },
    loginBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    btnDisabled: { opacity: 0.5 },
  });
}
