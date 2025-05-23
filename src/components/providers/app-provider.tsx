
"use client";
import type { ReactNode } from 'react';
import React, { createContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { Activity, Todo, Category, AppMode, RecurrenceRule, UINotification, HistoryLogEntry, HistoryLogActionKey, Translations, Assignee, PomodoroPhase } from '@/lib/types';
import { INITIAL_CATEGORIES }
from '@/lib/constants';
import { v4 as uuidv4 } from 'uuid';
import { useToast } from '@/hooks/use-toast';
import {
  isSameDay, formatISO, parseISO,
  addDays, addWeeks, addMonths,
  subDays, subWeeks,
  startOfDay as dateFnsStartOfDay, endOfDay as dateFnsEndOfDay,
  isBefore, isAfter,
  getDay, getDate,
  isWithinInterval,
  setDate as setDayOfMonthFn,
  addYears, isEqual,
  formatDistanceToNowStrict,
} from 'date-fns';
import * as Icons from 'lucide-react';
import { useTranslations } from '@/contexts/language-context';
import { enUS, es, fr } from 'date-fns/locale';
import { useTheme } from 'next-themes';


export interface AppContextType {
  activities: Activity[];
  getRawActivities: () => Activity[];
  categories: Category[];
  assignees: Assignee[];
  appMode: AppMode;
  setAppMode: (mode: AppMode) => void;
  addActivity: (
    activityData: Omit<Activity, 'id' | 'todos' | 'createdAt' | 'completed' | 'notes' | 'recurrence' | 'completedOccurrences' | 'responsiblePersonId'> & {
      todos?: Omit<Todo, 'id' | 'completed'>[];
      time?: string;
      notes?: string;
      recurrence?: RecurrenceRule | null;
      responsiblePersonId?: string;
    },
    customCreatedAt?: number
  ) => void;
  updateActivity: (activityId: string, updates: Partial<Activity>, originalActivity?: Activity) => void;
  deleteActivity: (activityId: string) => void;
  toggleOccurrenceCompletion: (masterActivityId: string, occurrenceDateTimestamp: number, completed: boolean) => void;
  addTodoToActivity: (activityId: string, todoText: string) => void;
  updateTodoInActivity: (activityId: string, todoId: string, updates: Partial<Todo>) => void;
  deleteTodoFromActivity: (activityId: string, todoId: string, masterActivityId?: string) => void;
  getCategoryById: (categoryId: string) => Category | undefined;
  addCategory: (name: string, iconName: string, mode: AppMode | 'all') => void;
  updateCategory: (categoryId: string, updates: Partial<Omit<Category, 'id' | 'icon'>>, oldCategoryData?: Category) => void;
  deleteCategory: (categoryId: string) => void;
  addAssignee: (name: string) => void;
  updateAssignee: (assigneeId: string, updates: Partial<Omit<Assignee, 'id'>>) => void;
  deleteAssignee: (assigneeId: string) => void;
  getAssigneeById: (assigneeId: string) => Assignee | undefined;
  isLoading: boolean;
  error: string | null;

  isAuthenticated: boolean;
  setIsAuthenticated: (value: boolean, rememberMe?: boolean) => void;
  loginAttempts: number;
  setLoginAttempts: (attempts: number) => void;
  lockoutEndTime: number | null;
  setLockoutEndTime: (timestamp: number | null) => void;
  sessionExpiryTimestamp: number | null;
  logout: () => void;
  logPasswordChange: () => void;

  uiNotifications: UINotification[];
  addUINotification: (data: Omit<UINotification, 'id' | 'timestamp' | 'read'>) => void;
  markUINotificationAsRead: (notificationId: string) => void;
  markAllUINotificationsAsRead: () => void;
  clearAllUINotifications: () => void;

  historyLog: HistoryLogEntry[];
  addHistoryLogEntry: (actionKey: HistoryLogActionKey, details?: Record<string, string | number | boolean | undefined>, scope?: HistoryLogEntry['scope']) => void;

  systemNotificationPermission: NotificationPermission | null;
  requestSystemNotificationPermission: () => Promise<void>;

  // Pomodoro Timer
  pomodoroPhase: PomodoroPhase;
  pomodoroTimeRemaining: number; // in seconds
  pomodoroIsRunning: boolean;
  pomodoroCyclesCompleted: number;
  startPomodoroWork: () => void;
  startPomodoroShortBreak: () => void;
  startPomodoroLongBreak: () => void;
  pausePomodoro: () => void;
  resumePomodoro: () => void;
  resetPomodoro: () => void;
  isPomodoroReady: boolean; // New state
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

const LOCAL_STORAGE_KEY_PERSONAL_ACTIVITIES = 'todoFlowPersonalActivities_v2';
const LOCAL_STORAGE_KEY_WORK_ACTIVITIES = 'todoFlowWorkActivities_v2';
const LOCAL_STORAGE_KEY_ALL_CATEGORIES = 'todoFlowAllCategories_v1';
const LOCAL_STORAGE_KEY_ASSIGNEES = 'todoFlowAssignees_v2';
const LOCAL_STORAGE_KEY_APP_MODE = 'todoFlowAppMode';
const LOCAL_STORAGE_KEY_IS_AUTHENTICATED = 'todoFlowIsAuthenticated';
const LOCAL_STORAGE_KEY_LOGIN_ATTEMPTS = 'todoFlowLoginAttempts';
const LOCAL_STORAGE_KEY_LOCKOUT_END_TIME = 'todoFlowLockoutEndTime';
const LOCAL_STORAGE_KEY_SESSION_EXPIRY = 'todoFlowSessionExpiry';
const LOCAL_STORAGE_KEY_UI_NOTIFICATIONS = 'todoFlowUINotifications_v1';
const SESSION_STORAGE_KEY_HISTORY_LOG = 'todoFlowHistoryLog_v1';


const SESSION_DURATION_24_HOURS_MS = 24 * 60 * 60 * 1000;
const SESSION_DURATION_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;


const getIconComponent = (iconName: string): Icons.LucideIcon => {
  const capitalizedIconName = iconName.charAt(0).toUpperCase() + iconName.slice(1);
  const pascalCaseIconName = capitalizedIconName.replace(/[^A-Za-z0-9]/g, '');
  return (Icons as any)[pascalCaseIconName] || Icons.Package;
};

let logoutChannel: BroadcastChannel | null = null;
if (typeof window !== 'undefined') {
  logoutChannel = new BroadcastChannel('todoFlowLogoutChannel');
}

const getStartOfDayUtil = (date: Date): Date => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

interface FutureInstance {
  instanceDate: Date;
  masterActivityId: string;
}

function generateFutureInstancesForNotifications(
  masterActivity: Activity,
  rangeStartDate: Date,
  rangeEndDate: Date
): FutureInstance[] {
  if (!masterActivity.recurrence || masterActivity.recurrence.type === 'none') {
    const activityDate = new Date(masterActivity.createdAt);
    if (isWithinInterval(activityDate, { start: rangeStartDate, end: rangeEndDate }) && !masterActivity.completed) {
        return [{ instanceDate: activityDate, masterActivityId: masterActivity.id }];
    }
    return [];
  }

  const instances: FutureInstance[] = [];
  const recurrence = masterActivity.recurrence;
  let currentDate = new Date(masterActivity.createdAt);

   if (isBefore(currentDate, rangeStartDate)) {
      if (recurrence.type === 'daily') {
          currentDate = rangeStartDate;
      } else if (recurrence.type === 'weekly' && recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
          let tempDate = dateFnsStartOfDay(rangeStartDate);
          while(isBefore(tempDate, new Date(masterActivity.createdAt)) || !recurrence.daysOfWeek.includes(getDay(tempDate)) || isBefore(tempDate, rangeStartDate)) {
              tempDate = addDays(tempDate, 1);
              if (isAfter(tempDate, rangeEndDate)) break;
          }
          currentDate = tempDate;
      } else if (recurrence.type === 'monthly' && recurrence.dayOfMonth) {
          let tempMasterStartMonthDay = setDayOfMonthFn(new Date(masterActivity.createdAt), recurrence.dayOfMonth);
          if (isBefore(tempMasterStartMonthDay, new Date(masterActivity.createdAt))) {
              tempMasterStartMonthDay = addMonths(tempMasterStartMonthDay, 1);
          }

          currentDate = setDayOfMonthFn(rangeStartDate, recurrence.dayOfMonth);
          if (isBefore(currentDate, rangeStartDate)) currentDate = addMonths(currentDate,1);
          if (isBefore(currentDate, tempMasterStartMonthDay)) {
             currentDate = tempMasterStartMonthDay;
          }
      }
  }


  const seriesEndDate = recurrence.endDate ? new Date(recurrence.endDate) : null;
  let iterations = 0;
  const maxIterations = 366 * 1; // Approx 1 year of daily occurrences for notifications

  while (iterations < maxIterations && !isAfter(currentDate, rangeEndDate)) {
    iterations++;

    if (seriesEndDate && isAfter(currentDate, seriesEndDate)) break;

    if (isBefore(currentDate, new Date(masterActivity.createdAt))) {
        if (recurrence.type === 'daily') currentDate = addDays(currentDate, 1);
        else if (recurrence.type === 'weekly') currentDate = addDays(currentDate, 1);
        else if (recurrence.type === 'monthly') {
            const nextMonth = addMonths(currentDate, 1);
            currentDate = recurrence.dayOfMonth ? setDayOfMonthFn(nextMonth, recurrence.dayOfMonth) : nextMonth;
        } else break;
        continue;
    }


    let isValidOccurrence = false;
    switch (recurrence.type) {
      case 'daily':
        isValidOccurrence = true;
        break;
      case 'weekly':
        if (recurrence.daysOfWeek?.includes(getDay(currentDate))) {
          isValidOccurrence = true;
        }
        break;
      case 'monthly':
        if (recurrence.dayOfMonth && getDate(currentDate) === recurrence.dayOfMonth) {
          isValidOccurrence = true;
        }
        break;
    }

    if (isValidOccurrence) {
      const occurrenceDateKey = formatISO(currentDate, { representation: 'date' });
      const isInstanceCompleted = !!masterActivity.completedOccurrences?.[occurrenceDateKey];

      if (!isInstanceCompleted) {
           instances.push({
            instanceDate: new Date(currentDate.getTime()),
            masterActivityId: masterActivity.id,
          });
      }
    }

    if (recurrence.type === 'daily') {
        currentDate = addDays(currentDate, 1);
    } else if (recurrence.type === 'weekly') {
        currentDate = addDays(currentDate, 1);
    } else if (recurrence.type === 'monthly') {
        if (recurrence.dayOfMonth) {
            let nextIterationDate;
            const currentMonthTargetDay = setDayOfMonthFn(currentDate, recurrence.dayOfMonth);

            if(isAfter(currentMonthTargetDay, currentDate) && getDate(currentMonthTargetDay) === recurrence.dayOfMonth){
                 nextIterationDate = currentMonthTargetDay;
            } else {
                 let nextMonthDate = addMonths(currentDate, 1);
                 nextIterationDate = setDayOfMonthFn(nextMonthDate, recurrence.dayOfMonth);
            }
            currentDate = nextIterationDate;
        } else {
            currentDate = addDays(currentDate, 1);
        }
    } else {
      break;
    }
  }
  return instances;
}

function parseHslString(hslString: string): { h: number; s: number; l: number } | null {
  if (!hslString) return null;
  const match = hslString.match(/^(?:hsl\(\s*)?(-?\d*\.?\d+)(?:deg|rad|turn|)?\s*[, ]?\s*(-?\d*\.?\d+)%?\s*[, ]?\s*(-?\d*\.?\d+)%?(?:\s*[,/]\s*(-?\d*\.?\d+)\%?)?(?:\s*\))?$/i);
  if (!match) return null;

  const h = parseFloat(match[1]);
  const s = parseFloat(match[2]);
  const l = parseFloat(match[3]);

  if (isNaN(h) || isNaN(s) || isNaN(l)) return null;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));

  const toHexByte = (c: number) => {
    const hex = Math.round(c * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  return `#${toHexByte(f(0))}${toHexByte(f(8))}${toHexByte(f(4))}`;
}

const POMODORO_WORK_DURATION_SECONDS = 25 * 60;
const POMODORO_SHORT_BREAK_DURATION_SECONDS = 5 * 60;
const POMODORO_LONG_BREAK_DURATION_SECONDS = 15 * 60;


export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [personalActivities, setPersonalActivities] = useState<Activity[]>([]);
  const [workActivities, setWorkActivities] = useState<Activity[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [allAssignees, setAllAssignees] = useState<Assignee[]>([]);
  const [appModeState, setAppModeState] = useState<AppMode>('personal');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const { t, locale } = useTranslations();

  const dateFnsLocale = useMemo(() => {
    if (locale === 'es') return es;
    if (locale === 'fr') return fr;
    return enUS;
  }, [locale]);

  const [lastNotificationCheckDay, setLastNotificationCheckDay] = useState<number | null>(null);
  const [notifiedToday, setNotifiedToday] = useState<Set<string>>(new Set());

  const [isAuthenticated, setIsAuthenticatedState] = useState<boolean>(false);
  const [loginAttempts, setLoginAttemptsState] = useState<number>(0);
  const [lockoutEndTime, setLockoutEndTimeState] = useState<number | null>(null);
  const [sessionExpiryTimestamp, setSessionExpiryTimestampState] = useState<number | null>(null);

  const [uiNotifications, setUINotifications] = useState<UINotification[]>([]);
  const [historyLog, setHistoryLog] = useState<HistoryLogEntry[]>([]);
  const { theme, resolvedTheme } = useTheme();
  const [systemNotificationPermission, setSystemNotificationPermission] = useState<NotificationPermission | null>(null);

  const [pomodoroPhase, setPomodoroPhase] = useState<PomodoroPhase>('off');
  const [pomodoroTimeRemaining, setPomodoroTimeRemaining] = useState(POMODORO_WORK_DURATION_SECONDS);
  const [pomodoroIsRunning, setPomodoroIsRunning] = useState(false);
  const [pomodoroCyclesCompleted, setPomodoroCyclesCompleted] = useState(0);
  const [isPomodoroReady, setIsPomodoroReady] = useState(false); // New state


  useEffect(() => {
    if (typeof window === 'undefined' || isLoading) {
      return;
    }
    const timerId = setTimeout(() => {
        const computedStyle = getComputedStyle(document.documentElement);
        const backgroundHslString = computedStyle.getPropertyValue('--background').trim();

        const hslValues = parseHslString(backgroundHslString);

        if (hslValues) {
        const hexColor = hslToHex(hslValues.h, hslValues.s, hslValues.l);

        let metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (!metaThemeColor) {
            metaThemeColor = document.createElement('meta');
            metaThemeColor.setAttribute('name', 'theme-color');
            document.getElementsByTagName('head')[0].appendChild(metaThemeColor);
        }
        metaThemeColor.setAttribute('content', hexColor);
        } else {
            console.warn("[AppProvider] Could not parse --background HSL string for theme-color:", backgroundHslString);
        }
    }, 0);

    return () => clearTimeout(timerId);

  }, [theme, resolvedTheme, appModeState, isLoading]);


  const getRawActivities = useCallback(() => {
    return appModeState === 'work' ? workActivities : personalActivities;
  }, [appModeState, workActivities, personalActivities]);

  const currentActivitySetter = useMemo(() => {
    return appModeState === 'work' ? setWorkActivities : setPersonalActivities;
  }, [appModeState]);

  const filteredCategories = useMemo(() => {
    if (isLoading) return [];
    return allCategories.filter(cat =>
      !cat.mode || cat.mode === 'all' || cat.mode === appModeState
    );
  }, [allCategories, appModeState, isLoading]);


  const assigneesForContext = useMemo(() => {
    if (isLoading) {
      return [];
    }
    // Assignees are now only for personal mode, no filtering needed here
    return allAssignees;
  }, [allAssignees, isLoading]);


  const addHistoryLogEntry = useCallback((actionKey: HistoryLogActionKey, details?: Record<string, string | number | boolean | undefined>, scope: HistoryLogEntry['scope'] = 'account') => {
    const newEntry: HistoryLogEntry = {
      id: uuidv4(),
      timestamp: Date.now(),
      actionKey,
      details,
      scope,
    };
    setHistoryLog(prevLog => [newEntry, ...prevLog.slice(0, 99)]);
  }, []);

  const addUINotification = useCallback((data: Omit<UINotification, 'id' | 'timestamp' | 'read'>) => {
    const newNotification: UINotification = {
      ...data,
      id: uuidv4(),
      timestamp: Date.now(),
      read: false,
    };
    setUINotifications(prev => [newNotification, ...prev.slice(0, 49)]);
  }, []);

  const showSystemNotification = useCallback((title: string, description: string) => {
    console.log(`[AppProvider] Attempting to show system notification. Title: "${title}"`);
    if (typeof window === 'undefined' || !('Notification' in window)) {
      console.warn("[AppProvider] This browser does not support desktop notification. Unable to show: ", title);
      return;
    }
    
    const currentPermission = Notification.permission; // Check current permission directly
    console.log(`[AppProvider] showSystemNotification - Current browser notification permission is: ${currentPermission}`);

    if (currentPermission === 'granted') {
      console.log("[AppProvider] Permission 'granted'. Showing system notification:", title);
      try {
        new Notification(title, {
            body: description,
            icon: '/icons/icon-192x192.png', 
            lang: locale,
        });
      } catch (error) {
        console.error("[AppProvider] Error creating system notification:", error);
      }
    } else {
      console.log(`[AppProvider] System notification for "${title}" was not shown because permission is '${currentPermission}'. User can enable via settings menu or explicit button.`);
    }
  }, [locale]);

  const requestSystemNotificationPermission = useCallback(async () => {
    console.log("[AppProvider] requestSystemNotificationPermission called.");
    if (typeof window === 'undefined' || !('Notification' in window)) {
      console.warn("[AppProvider] This browser does not support desktop notification.");
      setSystemNotificationPermission('denied');
      toast({ title: t('systemNotificationsBlocked'), description: "Browser does not support notifications." });
      return;
    }

    let currentPermission = Notification.permission;
    console.log(`[AppProvider] Current browser notification permission (at request time) is: ${currentPermission}`);

    if (currentPermission === 'granted') {
      console.log("[AppProvider] Notification permission already granted by browser.");
      setSystemNotificationPermission('granted');
      return;
    }

    if (currentPermission === 'denied') {
      console.log("[AppProvider] Notification permission is 'denied' by browser. User needs to change this in browser/OS settings.");
      setSystemNotificationPermission('denied');
      toast({ title: t('systemNotificationsBlocked'), description: t('enableSystemNotificationsDescription') as string, duration: 7000 });
      return;
    }

    console.log("[AppProvider] Notification permission is 'default'. Requesting permission from user via button click...");
    try {
      const permissionResult = await Notification.requestPermission();
      console.log(`[AppProvider] Notification.requestPermission() result: ${permissionResult}`);
      setSystemNotificationPermission(permissionResult);

      if (permissionResult === 'granted') {
        console.log("[AppProvider] Notification permission granted by user.");
        toast({ title: t('systemNotificationsEnabled'), description: t('systemNotificationsNowActive') as string });
      } else if (permissionResult === 'denied') {
        console.log("[AppProvider] Notification permission denied by user via prompt.");
        toast({ title: t('systemNotificationsBlocked'), description: t('systemNotificationsUserDenied') as string });
      } else {
        console.log("[AppProvider] Notification permission prompt dismissed by user (remains 'default').");
         toast({ title: t('systemNotificationsNotYetEnabled') as string, description: t('systemNotificationsDismissed') as string });
      }
    } catch (err) {
      console.error("[AppProvider] Error requesting notification permission:", err);
      setSystemNotificationPermission(Notification.permission);
    }
  }, [t, toast]);


  const logout = useCallback(() => {
    addHistoryLogEntry('historyLogLogout', undefined, 'account');
    setIsAuthenticatedState(false);
    setLoginAttemptsState(0);
    setLockoutEndTimeState(null);
    setSessionExpiryTimestampState(null);
    setHistoryLog([]);
    
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      console.log('[AppProvider] Sending RESET_TIMER to SW on logout.');
      navigator.serviceWorker.controller.postMessage({ type: 'RESET_TIMER', locale });
    } else {
        console.warn('[AppProvider] SW controller not available on logout for RESET_TIMER.');
        setPomodoroPhase('off');
        setPomodoroTimeRemaining(POMODORO_WORK_DURATION_SECONDS);
        setPomodoroIsRunning(false);
        setPomodoroCyclesCompleted(0);
        setIsPomodoroReady(false); // Reset Pomodoro readiness
    }


    if (typeof window !== 'undefined') {
        localStorage.removeItem(LOCAL_STORAGE_KEY_IS_AUTHENTICATED);
        localStorage.removeItem(LOCAL_STORAGE_KEY_LOGIN_ATTEMPTS);
        localStorage.removeItem(LOCAL_STORAGE_KEY_LOCKOUT_END_TIME);
        localStorage.removeItem(LOCAL_STORAGE_KEY_SESSION_EXPIRY);
        sessionStorage.removeItem(SESSION_STORAGE_KEY_HISTORY_LOG);
    }

    if (logoutChannel) {
      logoutChannel.postMessage('logout_event');
    }
  }, [addHistoryLogEntry, locale]);

 useEffect(() => {
    setIsLoading(true);
    let initialAuth = false;
    try {
      const storedPersonalActivities = localStorage.getItem(LOCAL_STORAGE_KEY_PERSONAL_ACTIVITIES);
      if (storedPersonalActivities) setPersonalActivities(JSON.parse(storedPersonalActivities));

      const storedWorkActivities = localStorage.getItem(LOCAL_STORAGE_KEY_WORK_ACTIVITIES);
      if (storedWorkActivities) setWorkActivities(JSON.parse(storedWorkActivities));

      let loadedCategories: Category[] = [];
      const storedAllCategoriesString = localStorage.getItem(LOCAL_STORAGE_KEY_ALL_CATEGORIES);

      if (storedAllCategoriesString) {
        try {
          const parsedCategories = JSON.parse(storedAllCategoriesString) as Array<Omit<Category, 'icon'>>;
          if (Array.isArray(parsedCategories) && parsedCategories.length > 0) {
            loadedCategories = parsedCategories.map((cat) => ({
              ...cat,
              icon: getIconComponent(cat.iconName || 'Package'),
              mode: cat.mode || 'all'
            }));
          }
        } catch (e) {
          console.error("[AppProvider] Failed to parse categories from localStorage.", e);
          loadedCategories = []; // Ensure it's an empty array on error
        }
      }
      
      if (loadedCategories.length === 0) { // Fallback if localStorage is empty or parsing failed
         console.log("[AppProvider] No categories in localStorage or empty/invalid array found, using INITIAL_CATEGORIES.");
         loadedCategories = INITIAL_CATEGORIES.map(cat => ({ ...cat, icon: getIconComponent(cat.iconName) }));
      }
      setAllCategories(loadedCategories);


      let loadedAssignees: Assignee[] = [];
      const storedAssigneesString = localStorage.getItem(LOCAL_STORAGE_KEY_ASSIGNEES);
      if (storedAssigneesString) {
          try {
              const parsedAssignees = JSON.parse(storedAssigneesString) as Assignee[];
              if (Array.isArray(parsedAssignees)) {
                  // No mode property to map for assignees anymore
                  loadedAssignees = parsedAssignees.map(asg => ({id: asg.id, name: asg.name}));
              }
          } catch (e) {
              console.error("[AppProvider] Failed to parse assignees from localStorage, using empty list.", e);
          }
      }
      setAllAssignees(loadedAssignees);


      const storedAppMode = localStorage.getItem(LOCAL_STORAGE_KEY_APP_MODE) as AppMode | null;
      if (storedAppMode && (storedAppMode === 'personal' || storedAppMode === 'work')) {
        setAppModeState(storedAppMode);
      }

      const storedAuth = localStorage.getItem(LOCAL_STORAGE_KEY_IS_AUTHENTICATED);
      const storedExpiry = localStorage.getItem(LOCAL_STORAGE_KEY_SESSION_EXPIRY);

      if (storedAuth === 'true' && storedExpiry) {
        const expiryTime = parseInt(storedExpiry, 10);
        if (Date.now() > expiryTime) {
          initialAuth = false;
          logout(); 
        } else {
          initialAuth = true;
          setSessionExpiryTimestampState(expiryTime);
        }
      }
      setIsAuthenticatedState(initialAuth);
      if (initialAuth) {
        const storedHistoryLog = sessionStorage.getItem(SESSION_STORAGE_KEY_HISTORY_LOG);
        if (storedHistoryLog) setHistoryLog(JSON.parse(storedHistoryLog));
      }


      const storedAttempts = localStorage.getItem(LOCAL_STORAGE_KEY_LOGIN_ATTEMPTS);
      setLoginAttemptsState(storedAttempts ? parseInt(storedAttempts, 10) : 0);

      const storedLockoutTime = localStorage.getItem(LOCAL_STORAGE_KEY_LOCKOUT_END_TIME);
      setLockoutEndTimeState(storedLockoutTime ? parseInt(storedLockoutTime, 10) : null);

      const storedUINotifications = localStorage.getItem(LOCAL_STORAGE_KEY_UI_NOTIFICATIONS);
      if (storedUINotifications) setUINotifications(JSON.parse(storedUINotifications));

      if (typeof window !== 'undefined' && 'Notification' in window) {
        setSystemNotificationPermission(Notification.permission);
      }

    } catch (err) {
      console.error("[AppProvider] Failed to load data from local storage", err);
      setError("Failed to load saved data.");
       if (!(Array.isArray(allCategories) && allCategories.length > 0)) {
        setAllCategories(INITIAL_CATEGORIES.map(cat => ({...cat, icon: getIconComponent(cat.iconName)})));
      }
    } finally {
      setIsLoading(false);
    }
  }, []); // Empty dependency array: runs only once on mount


  useEffect(() => {
    if (!isLoading) {
      localStorage.setItem(LOCAL_STORAGE_KEY_PERSONAL_ACTIVITIES, JSON.stringify(personalActivities));
    }
  }, [personalActivities, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      localStorage.setItem(LOCAL_STORAGE_KEY_WORK_ACTIVITIES, JSON.stringify(workActivities));
    }
  }, [workActivities, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      const serializableCategories = allCategories.map(({ icon, ...rest }) => rest);
      localStorage.setItem(LOCAL_STORAGE_KEY_ALL_CATEGORIES, JSON.stringify(serializableCategories));
    }
  }, [allCategories, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      // Assignees no longer have a mode property to serialize
      localStorage.setItem(LOCAL_STORAGE_KEY_ASSIGNEES, JSON.stringify(allAssignees.map(asg => ({id: asg.id, name: asg.name}))));
    }
  }, [allAssignees, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      localStorage.setItem(LOCAL_STORAGE_KEY_APP_MODE, appModeState);
      const root = document.documentElement;
      root.classList.remove('mode-personal', 'mode-work');
      root.classList.add(appModeState === 'work' ? 'mode-work' : 'mode-personal');
    }
  }, [appModeState, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        localStorage.setItem(LOCAL_STORAGE_KEY_IS_AUTHENTICATED, 'true');
      } else {
        localStorage.removeItem(LOCAL_STORAGE_KEY_IS_AUTHENTICATED);
      }
    }
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      localStorage.setItem(LOCAL_STORAGE_KEY_LOGIN_ATTEMPTS, String(loginAttempts));
    }
  }, [loginAttempts, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      if (lockoutEndTime === null) {
        localStorage.removeItem(LOCAL_STORAGE_KEY_LOCKOUT_END_TIME);
      } else {
        localStorage.setItem(LOCAL_STORAGE_KEY_LOCKOUT_END_TIME, String(lockoutEndTime));
      }
    }
  }, [lockoutEndTime, isLoading]);

   useEffect(() => {
    if (!isLoading) {
      if (sessionExpiryTimestamp === null) {
        localStorage.removeItem(LOCAL_STORAGE_KEY_SESSION_EXPIRY);
      } else {
        localStorage.setItem(LOCAL_STORAGE_KEY_SESSION_EXPIRY, String(sessionExpiryTimestamp));
      }
    }
  }, [sessionExpiryTimestamp, isLoading]);

  useEffect(() => {
    if(!isLoading) {
        localStorage.setItem(LOCAL_STORAGE_KEY_UI_NOTIFICATIONS, JSON.stringify(uiNotifications));
    }
  }, [uiNotifications, isLoading]);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      sessionStorage.setItem(SESSION_STORAGE_KEY_HISTORY_LOG, JSON.stringify(historyLog));
    }
  }, [historyLog, isLoading, isAuthenticated]);

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;

    const intervalId = setInterval(() => {
      const now = new Date();
      const today = getStartOfDayUtil(now);
      const currentDayOfMonthFromNow = now.getDate();

      if (lastNotificationCheckDay !== null && lastNotificationCheckDay !== currentDayOfMonthFromNow) {
        setNotifiedToday(new Set());
      }
      setLastNotificationCheckDay(currentDayOfMonthFromNow);

      const activitiesToScan = appModeState === 'work' ? workActivities : personalActivities;


      activitiesToScan.forEach(masterActivity => {
        const activityTitle = masterActivity.title;
        const masterId = masterActivity.id;


        if (masterActivity.time) {
          const todayInstances = generateFutureInstancesForNotifications(masterActivity, today, dateFnsEndOfDay(today));
          todayInstances.forEach(instance => {
            const occurrenceDateKey = formatISO(instance.instanceDate, { representation: 'date' });
            const notificationKey5Min = `${masterId}:${occurrenceDateKey}:5min_soon`;
            const isInstanceCompleted = !!masterActivity.completedOccurrences?.[occurrenceDateKey];

            if (!isInstanceCompleted && !notifiedToday.has(notificationKey5Min)) {
              const [hours, minutes] = masterActivity.time!.split(':').map(Number);
              const activityDateTime = new Date(instance.instanceDate);
              activityDateTime.setHours(hours, minutes, 0, 0);
              const fiveMinutesInMs = 5 * 60 * 1000;
              const timeDiffMs = activityDateTime.getTime() - now.getTime();

              if (timeDiffMs >= 0 && timeDiffMs <= fiveMinutesInMs) {
                const toastTitle = t('toastActivityStartingSoonTitle');
                const toastDesc = t('toastActivityStartingSoonDescription', { activityTitle, activityTime: masterActivity.time! });

                showSystemNotification(toastTitle, toastDesc);
                addUINotification({ title: toastTitle, description: toastDesc, activityId: masterId, instanceDate: instance.instanceDate.getTime() });
                toast({ title: toastTitle, description: toastDesc });
                setNotifiedToday(prev => new Set(prev).add(notificationKey5Min));
              }
            }
          });
        }


        if (masterActivity.recurrence && masterActivity.recurrence.type !== 'none') {
          const recurrenceType = masterActivity.recurrence.type;
          const futureCheckEndDate = addDays(today, 8); 
          const upcomingInstances = generateFutureInstancesForNotifications(masterActivity, addDays(today,1), futureCheckEndDate);

          upcomingInstances.forEach(instance => {
            const instanceDateKey = formatISO(instance.instanceDate, { representation: 'date' });
            const isOccurrenceCompleted = !!masterActivity.completedOccurrences?.[instanceDateKey];
            if(isOccurrenceCompleted) return;

            const notify = (typeKey: string, titleKey: keyof Translations, descKey: keyof Translations, params: { activityTitle: string }) => {
              const notificationFullKey = `${masterId}:${instanceDateKey}:${typeKey}`;
              if (!notifiedToday.has(notificationFullKey)) {
                const notifTitle = t(titleKey as any, params);
                const notifDesc = t(descKey as any, params);

                showSystemNotification(notifTitle, notifDesc);
                addUINotification({ title: notifTitle, description: notifDesc, activityId: masterId, instanceDate: instance.instanceDate.getTime() });
                toast({ title: notifTitle, description: notifDesc });
                setNotifiedToday(prev => new Set(prev).add(notificationFullKey));
              }
            };

            const oneDayBeforeInstance = dateFnsStartOfDay(subDays(instance.instanceDate, 1));
            const twoDaysBeforeInstance = dateFnsStartOfDay(subDays(instance.instanceDate, 2));
            const oneWeekBeforeInstance = dateFnsStartOfDay(subWeeks(instance.instanceDate, 1));

            if (recurrenceType === 'weekly') {
              if (isSameDay(today, oneDayBeforeInstance)) {
                notify('1day_weekly', 'toastActivityTomorrowTitle', 'toastActivityTomorrowDescription', { activityTitle });
              }
            } else if (recurrenceType === 'monthly') {
              if (isSameDay(today, oneWeekBeforeInstance)) {
                 notify('1week_monthly', 'toastActivityInOneWeekTitle', 'toastActivityInOneWeekDescription', { activityTitle });
              }
              if (isSameDay(today, twoDaysBeforeInstance)) {
                 notify('2days_monthly', 'toastActivityInTwoDaysTitle', 'toastActivityInTwoDaysDescription', { activityTitle });
              }
              if (isSameDay(today, oneDayBeforeInstance)) {
                 notify('1day_monthly', 'toastActivityTomorrowTitle', 'toastActivityTomorrowDescription', { activityTitle });
              }
            }
          });
        }
      });
    }, 60000); 

    return () => clearInterval(intervalId);
  }, [personalActivities, workActivities, appModeState, isLoading, isAuthenticated, toast, t, lastNotificationCheckDay, notifiedToday, addUINotification, dateFnsLocale, showSystemNotification, locale]);


  useEffect(() => {
    if (!logoutChannel) return;
    const handleLogoutMessage = (event: MessageEvent) => {
      if (event.data === 'logout_event' && isAuthenticated) {
        logout();
      }
    };
    logoutChannel.addEventListener('message', handleLogoutMessage);
    return () => {
      if (logoutChannel) {
        logoutChannel.removeEventListener('message', handleLogoutMessage);
      }
    };
  }, [isAuthenticated, logout]);

  const postToServiceWorker = useCallback((message: any) => {
    console.log('[AppProvider] Attempting to post message to SW:', message);
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({...message, locale});
      console.log('[AppProvider] Message posted to SW controller:', message);
    } else {
      console.warn('[AppProvider] Service Worker controller not active. Pomodoro command ignored:', message);
      toast({
          variant: 'destructive',
          title: t('pomodoroErrorTitle') as string,
          description: t('pomodoroSWNotReady') as string
      });
    }
  }, [locale, t, toast]);


 useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      console.warn("[AppProvider] Service Worker API not available in this browser.");
      return;
    }

    let swRegistrationAttempted = false; 

    const handleControllerChange = () => {
      if (navigator.serviceWorker.controller) {
        console.log('[AppProvider] New SW controller active via controllerchange. Sending GET_INITIAL_STATE.');
        postToServiceWorker({ type: 'GET_INITIAL_STATE' });
      } else {
        console.warn('[AppProvider] SW controllerchange event fired, but controller is null.');
      }
    };

    const handleSWMessage = (event: MessageEvent) => {
      console.log('[AppProvider] Message received from SW:', event.data);
      if (event.data && event.data.type) {
        if (event.data.type === 'TIMER_STATE') {
          const { phase, timeRemaining, isRunning, cyclesCompleted, phaseJustChanged, previousPhase } = event.data.payload;
          setPomodoroPhase(phase);
          setPomodoroTimeRemaining(timeRemaining);
          setPomodoroIsRunning(isRunning);
          setPomodoroCyclesCompleted(cyclesCompleted);
          setIsPomodoroReady(true); // SW has responded, Pomodoro system is ready

          if (phaseJustChanged && previousPhase !== 'off' && previousPhase !== undefined) {
            let titleKey: keyof Translations = 'pomodoroWorkSessionEnded';
            let descriptionKey: keyof Translations = 'pomodoroFocusOnTask';

            if (previousPhase === 'work') {
              titleKey = 'pomodoroWorkSessionEnded';
              descriptionKey = (cyclesCompleted > 0 && cyclesCompleted % 4 === 0) 
                ? 'pomodoroTakeALongBreak' 
                : 'pomodoroTakeAShortBreak';
            } else if (previousPhase === 'shortBreak') {
              titleKey = 'pomodoroShortBreakEnded';
              descriptionKey = 'pomodoroBackToWork';
            } else if (previousPhase === 'longBreak') {
              titleKey = 'pomodoroLongBreakEnded';
              descriptionKey = 'pomodoroBackToWork';
            }
            const title = t(titleKey);
            const description = t(descriptionKey);
            addUINotification({ title, description, activityId: `pomodoro_cycle_${cyclesCompleted}_${previousPhase}` });
            toast({ title, description });
          }
        } else if (event.data.type === 'SW_ERROR') {
          console.error('[AppProvider] Error message from SW:', event.data.payload);
          toast({
            variant: 'destructive',
            title: t('pomodoroErrorTitle'),
            description: `Service Worker: ${event.data.payload.message}`
          });
        }
      }
    };
    
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    navigator.serviceWorker.addEventListener('message', handleSWMessage);

    const registerServiceWorker = async () => {
      if (swRegistrationAttempted) {
        console.log('[AppProvider] SW registration already attempted in this effect run.');
        return;
      }
      swRegistrationAttempted = true;
      console.log('[AppProvider] registerServiceWorker function called.');

      try {
        console.log('[AppProvider] Attempting to register Service Worker /sw.js');
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        console.log('[AppProvider] Service Worker registered with scope:', registration.scope);
        
        if (navigator.serviceWorker.controller) {
          console.log('[AppProvider] SW controller active after registration. Sending GET_INITIAL_STATE.');
          postToServiceWorker({ type: 'GET_INITIAL_STATE' });
        } else {
          console.log('[AppProvider] No SW controller immediately after registration. Waiting for `ready` or `controllerchange`.');
          // `controllerchange` listener should handle it if a new controller takes over.
          // `ready` can also be a good point to check.
          registration.addEventListener('updatefound', () => {
            console.log('[AppProvider] SW update found. New worker is installing.');
          });
          await navigator.serviceWorker.ready;
          console.log('[AppProvider] navigator.serviceWorker.ready has resolved.');
           if (navigator.serviceWorker.controller) {
            console.log('[AppProvider] SW controller active after serviceWorker.ready. Sending GET_INITIAL_STATE.');
            postToServiceWorker({ type: 'GET_INITIAL_STATE' });
          } else {
            console.warn('[AppProvider] SW controller still not active after serviceWorker.ready. This might indicate a new SW is waiting to activate or the page isn\'t controlled.');
          }
        }
      } catch (error) {
        console.error('[AppProvider] Service Worker registration failed:', error);
        toast({
          variant: 'destructive',
          title: t('pomodoroErrorTitle'),
          description: `SW Reg Error: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    };

    const initSW = () => {
       if (document.readyState === 'complete') {
        console.log('[AppProvider] Document already complete, registering SW.');
        registerServiceWorker();
      } else {
        window.addEventListener('load', () => {
          console.log('[AppProvider] Window loaded, attempting to register Service Worker.');
          registerServiceWorker();
        }, { once: true });
      }
    };

    initSW();

    return () => {
      console.log('[AppProvider] Cleaning up SW listeners.');
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      navigator.serviceWorker.removeEventListener('message', handleSWMessage);
    };
  // Using postToServiceWorker and other stable functions from context without them being direct dependencies.
  // Re-running this whole effect for locale changes (which changes postToServiceWorker) can be problematic.
  // The postToServiceWorker function already captures the latest locale.
  }, [t, toast, addUINotification, locale]); // Added locale to ensure postToServiceWorker in callbacks uses the latest.


  const startPomodoroWork = useCallback(() => {
    console.log('[AppProvider] startPomodoroWork called.');
    postToServiceWorker({ type: 'START_WORK' });
  }, [postToServiceWorker]);

  const startPomodoroShortBreak = useCallback(() => {
    console.log('[AppProvider] startPomodoroShortBreak called.');
    postToServiceWorker({ type: 'START_SHORT_BREAK' });
  }, [postToServiceWorker]);

  const startPomodoroLongBreak = useCallback(() => {
    console.log('[AppProvider] startPomodoroLongBreak called.');
    postToServiceWorker({ type: 'START_LONG_BREAK' });
  }, [postToServiceWorker]);

  const pausePomodoro = useCallback(() => {
    console.log('[AppProvider] pausePomodoro called.');
    postToServiceWorker({ type: 'PAUSE_TIMER' });
  }, [postToServiceWorker]);

  const resumePomodoro = useCallback(() => {
    console.log('[AppProvider] resumePomodoro called.');
    postToServiceWorker({ type: 'RESUME_TIMER' });
  }, [postToServiceWorker]);

  const resetPomodoro = useCallback(() => {
    console.log('[AppProvider] resetPomodoro called.');
    postToServiceWorker({ type: 'RESET_TIMER' });
    setIsPomodoroReady(false); // Reset readiness, will be set to true upon receiving TIMER_STATE
  }, [postToServiceWorker]);


  const setAppMode = useCallback((mode: AppMode) => {
    if (mode !== appModeState) {
        addHistoryLogEntry(mode === 'personal' ? 'historyLogSwitchToPersonalMode' : 'historyLogSwitchToWorkMode', undefined, 'account');
    }
    setAppModeState(mode);
  }, [appModeState, addHistoryLogEntry]);

  const setIsAuthenticated = useCallback((value: boolean, rememberMe: boolean = false) => {
    const wasAuthenticated = isAuthenticated;
    setIsAuthenticatedState(value);

    if (value && !wasAuthenticated) {
        addHistoryLogEntry('historyLogLogin', undefined, 'account');
        if (typeof window !== 'undefined') {
          sessionStorage.removeItem(SESSION_STORAGE_KEY_HISTORY_LOG);
        }
        setHistoryLog([]);

        const title = t('loginSuccessNotificationTitle');
        const description = t('loginSuccessNotificationDescription');
        addUINotification({ title, description });
        showSystemNotification(title, description);
    }

    if (value) {
      const nowTime = Date.now();
      const expiryDuration = rememberMe ? SESSION_DURATION_30_DAYS_MS : SESSION_DURATION_24_HOURS_MS;
      const newExpiryTimestamp = nowTime + expiryDuration;
      setSessionExpiryTimestampState(newExpiryTimestamp);
    } else {
      setSessionExpiryTimestampState(null);
    }
  }, [isAuthenticated, addHistoryLogEntry, t, addUINotification, showSystemNotification]);

  const logPasswordChange = useCallback(() => {
    addHistoryLogEntry('historyLogPasswordChange', undefined, 'account');
  }, [addHistoryLogEntry]);

  const setLoginAttempts = useCallback((attempts: number) => {
    setLoginAttemptsState(attempts);
  }, []);

  const setLockoutEndTime = useCallback((timestamp: number | null) => {
    setLockoutEndTimeState(timestamp);
  }, []);

  const addActivity = useCallback((
      activityData: Omit<Activity, 'id' | 'todos' | 'createdAt' | 'completed' | 'notes' | 'recurrence' | 'completedOccurrences'| 'responsiblePersonId'> & {
        todos?: Omit<Todo, 'id' | 'completed'>[];
        time?: string;
        notes?: string;
        recurrence?: RecurrenceRule | null;
        responsiblePersonId?: string;
      },
      customCreatedAt?: number
    ) => {
    const newActivity: Activity = {
      id: uuidv4(),
      title: activityData.title,
      categoryId: activityData.categoryId,
      todos: (activityData.todos || []).map(todo => ({ ...todo, id: uuidv4(), completed: false })),
      createdAt: customCreatedAt !== undefined ? customCreatedAt : Date.now(),
      time: activityData.time === "" ? undefined : activityData.time,
      notes: activityData.notes || undefined,
      completed: false,
      recurrence: activityData.recurrence || { type: 'none' },
      completedOccurrences: {},
      responsiblePersonId: appModeState === 'personal' ? activityData.responsiblePersonId : undefined,
    };
    currentActivitySetter(prev => [...prev, newActivity]);
    addHistoryLogEntry(
      appModeState === 'personal' ? 'historyLogAddActivityPersonal' : 'historyLogAddActivityWork',
      { title: newActivity.title },
      appModeState
    );
  }, [currentActivitySetter, appModeState, addHistoryLogEntry]);

  const updateActivity = useCallback((activityId: string, updates: Partial<Activity>, originalActivity?: Activity) => {
    let activityTitleForLog = updates.title || originalActivity?.title || 'Unknown Activity';
    currentActivitySetter(prev =>
      prev.map(act => {
        if (act.id === activityId) {
          if (!originalActivity) originalActivity = act;
          activityTitleForLog = updates.title || originalActivity.title;

          const updatedRecurrence = updates.recurrence?.type === 'none'
            ? { type: 'none' }
            : updates.recurrence || act.recurrence;

          let updatedCompletedOccurrences = act.completedOccurrences;
          if (updates.recurrence && updates.recurrence.type === 'none') {
            updatedCompletedOccurrences = {};
          } else if (updates.recurrence &&
                     (updates.recurrence.type !== act.recurrence?.type ||
                      updates.recurrence.dayOfMonth !== act.recurrence?.dayOfMonth ||
                      JSON.stringify(updates.recurrence.daysOfWeek) !== JSON.stringify(act.recurrence?.daysOfWeek) ||
                      (updates.createdAt && new Date(updates.createdAt).getTime() !== new Date(act.createdAt).getTime())
                      )) {
            updatedCompletedOccurrences = {};
          }
          
          const updatedResponsiblePersonId = appModeState === 'personal'
            ? (updates.responsiblePersonId !== undefined ? updates.responsiblePersonId : act.responsiblePersonId)
            : undefined; 

          return { ...act, ...updates, recurrence: updatedRecurrence as RecurrenceRule | undefined, completedOccurrences: updatedCompletedOccurrences, responsiblePersonId: updatedResponsiblePersonId };
        }
        return act;
      })
    );
     addHistoryLogEntry(
      appModeState === 'personal' ? 'historyLogUpdateActivityPersonal' : 'historyLogUpdateActivityWork',
      { title: activityTitleForLog },
      appModeState
    );
  }, [currentActivitySetter, appModeState, addHistoryLogEntry]);

  const deleteActivity = useCallback((activityId: string) => {
    let deletedActivityTitle = 'Unknown Activity';
    const currentActivities = appModeState === 'work' ? workActivities : personalActivities;
    const activityToDelete = currentActivities.find(act => act.id === activityId);
    if (activityToDelete) {
        deletedActivityTitle = activityToDelete.title;
    }

    currentActivitySetter(prev => prev.filter(act => act.id !== activityId));
    addHistoryLogEntry(
        appModeState === 'personal' ? 'historyLogDeleteActivityPersonal' : 'historyLogDeleteActivityWork',
        { title: deletedActivityTitle },
        appModeState
    );
  }, [currentActivitySetter, appModeState, addHistoryLogEntry, personalActivities, workActivities]);

  const toggleOccurrenceCompletion = useCallback((masterActivityId: string, occurrenceDateTimestamp: number, completedState: boolean) => {
    let activityTitleForLog = 'Unknown Activity';
    const currentActivities = appModeState === 'work' ? workActivities : personalActivities;
    const masterActivity = currentActivities.find(act => act.id === masterActivityId);
    if (masterActivity) {
      activityTitleForLog = masterActivity.title;
    }

    const occurrenceDateKey = formatISO(new Date(occurrenceDateTimestamp), { representation: 'date' });
    currentActivitySetter(prevActivities =>
      prevActivities.map(act => {
        if (act.id === masterActivityId) {
          const updatedOccurrences = { ...act.completedOccurrences };
          if (completedState) {
            updatedOccurrences[occurrenceDateKey] = true;
          } else {
            delete updatedOccurrences[occurrenceDateKey];
          }
          return { ...act, completedOccurrences: updatedOccurrences };
        }
        return act;
      })
    );
    addHistoryLogEntry(
        appModeState === 'personal' ? 'historyLogToggleActivityCompletionPersonal' : 'historyLogToggleActivityCompletionWork',
        { title: activityTitleForLog, completed: completedState ? 1 : 0 },
        appModeState
    );
  }, [currentActivitySetter, appModeState, addHistoryLogEntry, personalActivities, workActivities]);


  const addTodoToActivity = useCallback((activityId: string, todoText: string) => {
    const newTodo: Todo = { id: uuidv4(), text: todoText, completed: false };
    currentActivitySetter(prev =>
      prev.map(act =>
        act.id === activityId ? { ...act, todos: [...act.todos, newTodo] } : act
      )
    );
  }, [currentActivitySetter]);

  const updateTodoInActivity = useCallback(
    (activityId: string, todoId: string, updates: Partial<Todo>) => {
      currentActivitySetter(prev =>
        prev.map(act =>
          act.id === activityId
            ? {
                ...act,
                todos: act.todos.map(todo =>
                  todo.id === todoId ? { ...todo, ...updates } : todo
                ),
              }
            : act
        )
      );
    },
    [currentActivitySetter]
  );

  const deleteTodoFromActivity = useCallback((activityId: string, todoId: string) => {
    currentActivitySetter(prev =>
      prev.map(act =>
        act.id === activityId
          ? { ...act, todos: act.todos.filter(todo => todo.id !== todoId) }
          : act
      )
    );
  }, [currentActivitySetter]);

  const getCategoryById = useCallback(
    (categoryId: string) => {
      return allCategories.find(cat => cat.id === categoryId)
    },
    [allCategories]
  );

  const addCategory = useCallback((name: string, iconName: string, mode: AppMode | 'all') => {
    const IconComponent = getIconComponent(iconName);
    const newCategory: Category = {
      id: `cat_${uuidv4()}`,
      name,
      icon: IconComponent,
      iconName,
      mode: mode,
    };
    setAllCategories(prev => [...prev, newCategory]);
    const toastDesc = t('toastCategoryAddedDescription', { categoryName: name });
    toast({ title: t('toastCategoryAddedTitle'), description: toastDesc });

    let actionKey: HistoryLogActionKey;
    if (mode === 'personal') actionKey = 'historyLogAddCategoryPersonal';
    else if (mode === 'work') actionKey = 'historyLogAddCategoryWork';
    else actionKey = 'historyLogAddCategoryAll';
    addHistoryLogEntry(actionKey, { name }, 'category');

  }, [toast, t, addHistoryLogEntry]);

  const updateCategory = useCallback((categoryId: string, updates: Partial<Omit<Category, 'id' | 'icon'>>, oldCategoryData?: Category) => {
    let categoryNameForLog = updates.name;
    let categoryModeForLog = updates.mode;

    setAllCategories(prev =>
      prev.map(cat => {
        if (cat.id === categoryId) {
          const originalName = cat.name;
          const originalMode = cat.mode;
          const newName = updates.name !== undefined ? updates.name : cat.name;
          const newIconName = updates.iconName !== undefined ? updates.iconName : cat.iconName;
          const newMode = updates.mode !== undefined ? updates.mode : cat.mode;

          if (!categoryNameForLog) categoryNameForLog = newName;
          if (!categoryModeForLog) categoryModeForLog = newMode;

          return {
            ...cat,
            name: newName,
            iconName: newIconName,
            icon: updates.iconName !== undefined ? getIconComponent(newIconName) : cat.icon,
            mode: newMode,
          };
        }
        return cat;
      })
    );

    const catName = categoryNameForLog || oldCategoryData?.name || "Unknown Category";
    const catMode = categoryModeForLog || oldCategoryData?.mode || "all";
    const toastDesc = t('toastCategoryUpdatedDescription', { categoryName: catName });
    toast({ title: t('toastCategoryUpdatedTitle'), description: toastDesc });

    let actionKey: HistoryLogActionKey;
    if (catMode === 'personal') actionKey = 'historyLogUpdateCategoryPersonal';
    else if (catMode === 'work') actionKey = 'historyLogUpdateCategoryWork';
    else actionKey = 'historyLogUpdateCategoryAll';
    addHistoryLogEntry(actionKey, { name: catName }, 'category');

  }, [toast, t, addHistoryLogEntry]);


  const deleteCategory = useCallback((categoryId: string) => {
    const categoryToDelete = allCategories.find(cat => cat.id === categoryId);
    if (!categoryToDelete) return;

    addHistoryLogEntry('historyLogDeleteCategory', { name: categoryToDelete.name }, 'category');

    setAllCategories(prev => prev.filter(cat => cat.id !== categoryId));

    setPersonalActivities(prevActivities =>
      prevActivities.map(act =>
        act.categoryId === categoryId ? { ...act, categoryId: '' } : act
      )
    );
    setWorkActivities(prevActivities =>
      prevActivities.map(act =>
        act.categoryId === categoryId ? { ...act, categoryId: '' } : act
      )
    );
    const toastDesc = t('toastCategoryDeletedDescription', { categoryName: categoryToDelete.name });
    toast({ title: t('toastCategoryDeletedTitle'), description: toastDesc });
  }, [toast, allCategories, t, addHistoryLogEntry]);


  const addAssignee = useCallback((name: string) => {
    const newAssignee: Assignee = { id: `asg_${uuidv4()}`, name };
    setAllAssignees(prev => [...prev, newAssignee]);
    toast({ title: t('toastAssigneeAddedTitle'), description: t('toastAssigneeAddedDescription', { assigneeName: name }) });
    addHistoryLogEntry('historyLogAddAssignee', { name }, 'assignee');
  }, [t, toast, addHistoryLogEntry]);

  const updateAssignee = useCallback((assigneeId: string, updates: Partial<Omit<Assignee, 'id'>>) => {
    let assigneeNameForLog = updates.name;
    let oldNameForLog: string | undefined = undefined;

    setAllAssignees(prev =>
      prev.map(asg => {
        if (asg.id === assigneeId) {
          oldNameForLog = asg.name;
          const newName = updates.name !== undefined ? updates.name : asg.name;
          if (!assigneeNameForLog) assigneeNameForLog = newName;
          return { ...asg, name: newName };
        }
        return asg;
      })
    );

    const asgName = assigneeNameForLog || "Unknown Assignee";
    toast({ title: t('toastAssigneeUpdatedTitle'), description: t('toastAssigneeUpdatedDescription', { assigneeName: asgName }) });
    addHistoryLogEntry('historyLogUpdateAssignee', { name: asgName, oldName: oldNameForLog !== asgName ? oldNameForLog : undefined }, 'assignee');
  }, [t, toast, addHistoryLogEntry]);

  const deleteAssignee = useCallback((assigneeId: string) => {
    const assigneeToDelete = allAssignees.find(asg => asg.id === assigneeId);
    if (!assigneeToDelete) return;

    setAllAssignees(prev => prev.filter(asg => asg.id !== assigneeId));

    const clearAssigneeFromActivities = (activities: Activity[]) =>
      activities.map(act =>
        act.responsiblePersonId === assigneeId ? { ...act, responsiblePersonId: undefined } : act
      );
    setPersonalActivities(clearAssigneeFromActivities);

    toast({ title: t('toastAssigneeDeletedTitle'), description: t('toastAssigneeDeletedDescription', { assigneeName: assigneeToDelete.name }) });
    addHistoryLogEntry('historyLogDeleteAssignee', { name: assigneeToDelete.name }, 'assignee');
  }, [allAssignees, t, toast, addHistoryLogEntry]);

  const getAssigneeById = useCallback((assigneeId: string) => {
    return allAssignees.find(asg => asg.id === assigneeId);
  }, [allAssignees]);


  const markUINotificationAsRead = useCallback((notificationId: string) => {
    setUINotifications(prev =>
      prev.map(n => n.id === notificationId ? { ...n, read: true } : n)
    );
  }, []);

  const markAllUINotificationsAsRead = useCallback(() => {
    setUINotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const clearAllUINotifications = useCallback(() => {
    setUINotifications([]);
  }, []);


  return (
    <AppContext.Provider
      value={{
        activities: getRawActivities(),
        getRawActivities,
        categories: filteredCategories,
        assignees: assigneesForContext,
        appMode: appModeState,
        setAppMode,
        addActivity,
        updateActivity,
        deleteActivity,
        toggleOccurrenceCompletion,
        addTodoToActivity,
        updateTodoInActivity,
        deleteTodoFromActivity,
        getCategoryById,
        addCategory,
        updateCategory,
        deleteCategory,
        addAssignee,
        updateAssignee,
        deleteAssignee,
        getAssigneeById,
        isLoading,
        error,
        isAuthenticated,
        setIsAuthenticated,
        loginAttempts,
        setLoginAttempts,
        lockoutEndTime,
        setLockoutEndTime,
        sessionExpiryTimestamp,
        logout,
        logPasswordChange,
        uiNotifications,
        addUINotification,
        markUINotificationAsRead,
        markAllUINotificationsAsRead,
        clearAllUINotifications,
        historyLog,
        addHistoryLogEntry,
        systemNotificationPermission,
        requestSystemNotificationPermission,
        // Pomodoro
        pomodoroPhase,
        pomodoroTimeRemaining,
        pomodoroIsRunning,
        pomodoroCyclesCompleted,
        startPomodoroWork,
        startPomodoroShortBreak,
        startPomodoroLongBreak,
        pausePomodoro,
        resumePomodoro,
        resetPomodoro,
        isPomodoroReady,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

