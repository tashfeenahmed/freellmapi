import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Home,
  Key,
  Settings,
  Sparkles,
  Target,
  Upload,
  Zap,
} from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { TierOnboarding } from '@/components/TierOnboarding'
import { ProviderStatus } from '@/components/ProviderStatus'

type Step = 'welcome' | 'tiers' | 'providers' | 'import' | 'test'

interface DSHSettingsResponse {
  tiers: any[]
  providers: any[]
}

export function OnboardingPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>('welcome')
  const [dshFile, setDshFile] = useState<File | null>(null)
  const [importResult, setImportResult] = useState<any>(null)
  const [importing, setImporting] = useState(false)

  const { data: settings } = useQuery<DSHSettingsResponse>({
    queryKey: ['dsh', 'settings'],
    queryFn: () => apiFetch('/api/dsh/settings'),
  })

  const importMutation = useMutation({
    mutationFn: () => {
      if (!dshFile) throw new Error('No file selected')
      const formData = new FormData()
      formData.append('file', dshFile)
      setImporting(true)
      return apiFetch('/api/dsh/import', {
        method: 'POST',
        body: formData,
      })
    },
    onSuccess: (result) => {
      setImportResult(result)
      queryClient.invalidateQueries({ queryKey: ['dsh', 'settings'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
    onSettled: () => setImporting(false),
  })

  const testMutation = useMutation({
    mutationFn: (provider: any) =>
      apiFetch('/api/dsh/test', {
        method: 'POST',
        body: JSON.stringify({
          providerName: provider.name,
          baseURL: provider.baseURL,
        }),
      }),
  })

  const steps: { id: Step; title: string; description: string; icon: any }[] = [
    { id: 'welcome', title: 'Welcome', description: 'Get started with JiMesh', icon: Sparkles },
    { id: 'tiers', title: 'Tiers', description: 'Explore S/A/B tier chains', icon: Target },
    { id: 'providers', title: 'Providers', description: 'Configure API keys', icon: Key },
    { id: 'import', title: 'Import', description: 'Import from DSH settings', icon: Upload },
    { id: 'test', title: 'Test', description: 'Verify your setup', icon: Zap },
  ]

  const completedSteps: Step[] = []
  if (step !== 'welcome') completedSteps.push('welcome')
  if (step !== 'welcome' && step !== 'tiers') completedSteps.push('tiers')
  if (step !== 'welcome' && step !== 'tiers' && step !== 'providers') completedSteps.push('providers')

  const goNext = () => {
    const currentIndex = steps.findIndex(s => s.id === step)
    if (currentIndex < steps.length - 1) {
      setStep(steps[currentIndex + 1].id)
    }
  }

  const goPrev = () => {
    const currentIndex = steps.findIndex(s => s.id === step)
    if (currentIndex > 0) {
      setStep(steps[currentIndex - 1].id)
    }
  }

  const configuredProviders = settings?.providers?.filter((p: any) => p.keyConfigured).length || 0

  const completeOnboarding = () => {
    localStorage.setItem('jimesh_onboarding_complete', 'true')
    navigate('/models/chat')
  }

  const canComplete = configuredProviders > 0 || importResult?.success

  return (
    <div className="min-h-screen bg-background">
      {/* Progress Bar */}
      <div className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-6 py-4">
          <div className="flex items-center gap-4">
            {steps.map((s, i) => {
              const isCompleted = completedSteps.includes(s.id)
              const isCurrent = s.id === step
              const isFuture = !isCompleted && !isCurrent

              return (
                <> 
                  <div className="flex items-center">
                    <div className="relative flex items-center">
                      <div
                        className={`size-8 rounded-full flex items-center justify-center border-2 transition-all ${
                          isCompleted
                            ? 'bg-green-500 border-green-500 text-white'
                            : isCurrent
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-muted bg-background text-muted-foreground'
                        }`}
                      >
                        {isCompleted ? <Check className="size-4" /> : <s.icon className="size-4" />}
                      </div>
                      {isFuture && !isCurrent && i < steps.length - 1 && (
                        <div className="absolute left-full w-16 h-0.5 -translate-y-1/2 top-1/2 bg-muted" />
                      )}
                    </div>
                    <span className={`ml-2 text-xs font-medium ${
                      isCompleted || isCurrent ? 'text-foreground' : 'text-muted-foreground'
                    }`}>
                      {s.title}
                    </span>
                  </div>
                </>
              )
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* Step Content */}
        <div className="space-y-6">
          {/* Step 1: Welcome */}
          {step === 'welcome' && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="text-primary" />
                  Welcome to JiMesh
                </CardTitle>
                <CardDescription>
                  JiMesh is your intelligent LLM router. It automatically selects the best model for each task
                  across multiple providers and tiers. Let's get you set up!
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FeatureCard
                    icon={<Target className="size-6" />}
                    title="Smart Tier Routing"
                    description="S/A/B tier chains route requests to the best available model based on task complexity"
                  />
                  <FeatureCard
                    icon={<Zap className="size-6" />}
                    title="Multi-Provider Support"
                    description="Unified API across 20+ providers with automatic failover and load balancing"
                  />
                  <FeatureCard
                    icon={<Settings className="size-6" />}
                    title="DSH Compatible"
                    description="Import your DeepSeek Harness settings directly for instant setup"
                  />
                </div>

                <div className="p-4 bg-muted/50 rounded-lg">
                  <h4 className="font-medium mb-2">What you'll need:</h4>
                  <ul className="text-sm space-y-1 text-muted-foreground">
                    <li>• API keys for your preferred providers (Lightning AI, B.AI, etc.)</li>
                    <li>• Optional: DSH settings.yaml file for quick import</li>
                    <li>• JiMesh running on port 3011 for S-Tier models</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 2: Tiers */}
          {step === 'tiers' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium mb-2">Your Tier Chains</h3>
                <p className="text-sm text-muted-foreground">
                  JiMesh comes with three pre-configured tier chains. Explore the models available in each tier.
                </p>
              </div>
              <TierOnboarding showHeader={false} />
            </div>
          )}

          {/* Step 3: Providers */}
          {step === 'providers' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium mb-2">Configure Providers</h3>
                <p className="text-sm text-muted-foreground">
                  Add API keys for each provider to unlock their models. Click "Get Key" to visit the provider's website.
                </p>
              </div>
              <ProviderStatus
                onConfigure={() => {
                  // Open settings dialog or navigate to keys page
                  navigate('/keys')
                }}
              />
            </div>
          )}

          {/* Step 4: Import */}
          {step === 'import' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium mb-2">Import from DSH</h3>
                <p className="text-sm text-muted-foreground">
                  Have a DeepSeek Harness settings.yaml? Upload it to automatically configure all your providers.
                </p>
              </div>

              <Card>
                <CardContent className="pt-6">
                  {importResult ? (
                    <ImportResultCard result={importResult} onDismiss={() => setImportResult(null)} />
                  ) : (
                    <FileUploadArea
                      file={dshFile}
                      onChange={setDshFile}
                      onImport={() => importMutation.mutate()}
                      disabled={importing || !dshFile}
                    />
                  )}
                </CardContent>
              </Card>

              {importResult && (
                <Card>
                  <CardHeader>
                    <CardTitle>Import Complete</CardTitle>
                    <CardDescription>
                      {importResult.imported} providers configured, {importResult.skipped} skipped
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ProviderStatus compact />
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Step 5: Test */}
          {step === 'test' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium mb-2">Test Your Setup</h3>
                <p className="text-sm text-muted-foreground">
                  Verify all configured providers are reachable. Green means ready to use.
                </p>
              </div>

              <ProviderStatus
                onConfigure={(provider) => {
                  testMutation.mutate(provider)
                }}
              />

              {settings?.providers && settings.providers.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Quick Actions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-3 flex-wrap">
                      <Button variant="default" onClick={completeOnboarding} disabled={!canComplete}>
                        <CheckCircle2 className="size-4 mr-2" />
                        Complete Setup
                      </Button>
                      <Button variant="outline" onClick={() => navigate('/playground')}>
                        <Home className="size-4 mr-2" />
                        Try Playground
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex justify-between pt-6 border-t">
          {step !== 'welcome' && (
            <Button variant="outline" onClick={goPrev}>
              <ArrowLeft className="size-4 mr-2" />
              Back
            </Button>
          )}
          {step !== 'test' ? (
            <Button onClick={goNext}>
              Next
              <ArrowRight className="size-4 ml-2" />
            </Button>
          ) : canComplete ? (
            <Button onClick={completeOnboarding}>
              <CheckCircle2 className="size-4 mr-2" />
              Complete Setup
            </Button>
          ) : (
            <Button variant="outline" onClick={() => navigate('/keys')}>
              Configure Keys First
            </Button>
          )}
        </div>
      </main>
    </div>
  )
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="text-primary mb-3">{icon}</div>
        <h4 className="font-medium mb-1">{title}</h4>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

function ImportResultCard({ result, onDismiss }: { result: any; onDismiss: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">Import Complete</p>
          <p className="text-sm text-muted-foreground">
            {result.imported} imported, {result.skipped} skipped
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onDismiss}>
          ✕
        </Button>
      </div>
      {result.errors.length > 0 && (
        <div className="text-sm text-destructive">
          <ul className="list-disc list-inside space-y-1">
            {result.errors.map((e: string, i: number) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function FileUploadArea({
  file,
  onChange,
  onImport,
  disabled,
}: {
  file: File | null
  onChange: (file: File | null) => void
  onImport: () => void
  disabled: boolean
}) {
  const [dragActive, setDragActive] = useState(false)

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files.length > 0) {
      const f = e.dataTransfer.files[0]
      if (f.name.endsWith('.yaml') || f.name.endsWith('.yml')) {
        onChange(f)
      }
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      onChange(e.target.files[0])
    }
  }

  if (file) {
    return (
      <div className="p-4 bg-muted/50 rounded-lg border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📄</span>
            <div>
              <p className="font-medium">{file.name}</p>
              <p className="text-sm text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onChange(null)}>
              Remove
            </Button>
            <Button onClick={onImport} disabled={disabled}>
              <Upload className="size-4 mr-1" />
              Import
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`p-8 text-center border-2 border-dashed rounded-lg transition-colors ${
        dragActive ? 'border-primary bg-primary/5' : 'border-muted'
      }`}
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      <input
        type="file"
        accept=".yaml,.yml"
        onChange={handleFileSelect}
        className="hidden"
        id="dsh-file"
      />
      <label htmlFor="dsh-file" className="cursor-pointer">
        <Upload className="size-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-lg font-medium mb-1">Drop your DSH settings.yaml here</p>
        <p className="text-sm text-muted-foreground">or click to browse</p>
      </label>
    </div>
  )
}