cmake_minimum_required(VERSION 3.22.1)
project(whatsappcentral)
set(CMAKE_CXX_STANDARD 17)

# Ponte entre o Java e o motor Node (libnode.so do nodejs-mobile).
add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE ${CMAKE_SOURCE_DIR}/../../../../vendor/nodejs-mobile/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
target_link_options(native-lib PRIVATE "-Wl,-z,max-page-size=16384")
