import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    kotlin("jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        intellijIdea(providers.gradleProperty("platformVersion"))
        // The embedded browser: a plugin of its own since 2026.2 (see the <depends> in plugin.xml).
        bundledPlugin("com.intellij.modules.jcef")
        pluginVerifier()
        zipSigner()
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
        // The IDE brings its own Kotlin runtime, older than this compiler: stay within what it has.
        apiVersion = KotlinVersion.KOTLIN_2_3
        languageVersion = KotlinVersion.KOTLIN_2_3
        // Interface methods with a default body are inherited, not re-declared in our classes (the verifier reads those
        // copies as our use of deprecated and experimental API).
        freeCompilerArgs.add("-Xjvm-default=all")
    }
}

intellijPlatform {
    // Off together with prepareJarSearchableOptions, which otherwise expects their output after a clean.
    buildSearchableOptions = false

    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            // No upper bound: a plugin that sticks to the platform API should not be cut off by the next release.
            untilBuild = provider { null }
        }
        changeNotes = providers.gradleProperty("pluginVersion").map { "First JetBrains release ($it): the Claudestrator dashboard and task list, identical to the VS Code extension." }
    }

    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }

    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
        // `default` for releases; set PUBLISH_CHANNEL=eap to ship to the early-access channel first.
        channels = providers.environmentVariable("PUBLISH_CHANNEL").map { listOf(it) }.orElse(listOf("default"))
    }

    pluginVerification {
        ides {
            // What Marketplace itself checks against, plus the IDE this is meant for.
            recommended()
            create(IntelliJPlatformType.WebStorm, providers.gradleProperty("verifyWebStormVersion").orElse("2026.2"))
        }
    }
}

val npm = if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm"
val extensionDir = layout.projectDirectory.dir("../../claudestrator")
val sidecarDir = layout.projectDirectory.dir("sidecar")

// The webview scripts are the VS Code extension's own build output; the sidecar bundles the engine around them.
val buildExtension by tasks.registering(Exec::class) {
    group = "build"
    description = "Builds claudestrator/ (the webview scripts and the engine's types)."
    workingDir = extensionDir.asFile
    commandLine(npm, "run", "build")
    inputs.files(extensionDir.asFileTree.matching { include("package-lock.json", "extension.ts", "src/**", "media/**", "hook/**", "tsconfig*.json") })
    outputs.dir(extensionDir.dir("dist/media"))
}

val buildSidecar by tasks.registering(Exec::class) {
    group = "build"
    description = "Bundles the engine and the stdio bridge into sidecar/dist/engine."
    dependsOn(buildExtension)
    workingDir = sidecarDir.asFile
    commandLine(npm, "run", "build")
    inputs.files(sidecarDir.asFileTree.matching { include("package-lock.json", "build.mjs", "src/**") })
    inputs.dir(extensionDir.dir("dist/media"))
    inputs.files(extensionDir.asFileTree.matching { include("src/**", "media/**", "hook/**") })
    outputs.dir(sidecarDir.dir("dist/engine"))
}

// The engine runs as a Node process and needs real files, so it goes next to the jar, not inside it.
tasks.prepareSandbox {
    dependsOn(buildSidecar)
    from(sidecarDir.dir("dist/engine")) { into(pluginName.map { "$it/engine" }) }
}

// The engine reports this as the version of the dashboard (see EngineService.pluginVersion).
val generateVersionFile by tasks.registering(WriteProperties::class) {
    destinationFile = layout.buildDirectory.file("generated/claudestrator.properties")
    property("version", providers.gradleProperty("pluginVersion"))
}

tasks.processResources { from(generateVersionFile) }

tasks.wrapper { gradleVersion = "9.8.2" }
