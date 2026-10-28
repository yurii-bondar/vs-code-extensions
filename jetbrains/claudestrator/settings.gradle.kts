plugins {
    // Downloads the JDK the build asks for (21, what the IDE runs on) when the machine has none.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = providers.gradleProperty("pluginName").get()
