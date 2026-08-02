import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api'
import type { Subject, SchoolClass, Article, Resource, QueryTask, ExpLog, Notice } from '@/types'

export const useDataStore = defineStore('data', () => {
  const subjects = ref<any[]>([])
  const classes = ref<any[]>([])
  const articles = ref<any[]>([])
  const resources = ref<any[]>([])
  const queryTasks = ref<any[]>([])
  const expLogs = ref<any[]>([])
  const notices = ref<any[]>([])
  const loading = ref(false)

  async function fetchSubjects() { subjects.value = (await api.subjects()) as any }
  async function fetchClasses() { classes.value = (await api.classes()) as any }
  async function fetchArticles(params: any = {}) { articles.value = (await api.articles(params)) as any }
  async function fetchResources(params: any = {}) { resources.value = (await api.resources(params)) as any }
  async function fetchQueryTasks() { queryTasks.value = (await api.queryTasks()) as any }
  async function fetchExpLogs(userId?: number) { expLogs.value = (await api.expLogs(userId)) as any }
  async function fetchNotices() { notices.value = (await api.notices()) as any }

  const pendingArticles = computed(() => articles.value.filter(a => a.status === 'pending'))
  const pendingResources = computed(() => resources.value.filter(r => r.status === 'pending'))

  function subjectBySlug(slug: string) { return subjects.value.find(s => s.slug === slug) }
  function subjectById(id: number) { return subjects.value.find(s => s.id === id) }
  function classById(id: number) { return classes.value.find(c => c.id === id) }

  async function loadCommon() {
    loading.value = true
    try { await Promise.all([fetchSubjects(), fetchClasses()]) } finally { loading.value = false }
  }

  return {
    subjects, classes, articles, resources, queryTasks, expLogs, notices, loading,
    pendingArticles, pendingResources,
    subjectBySlug, subjectById, classById,
    fetchSubjects, fetchClasses, fetchArticles, fetchResources, fetchQueryTasks, fetchExpLogs, fetchNotices,
    loadCommon, api
  }
})
